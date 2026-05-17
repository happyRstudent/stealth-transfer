import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { PUBLIC_RPCS } from '../src/chains/solana/rpc.js';
import {
  buildRecoveryTransaction,
  confirmSolanaTransaction,
  createRecoverableRoute,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  estimateTransferFee,
  getBatchRange,
  hydrateIntermediateKeypairs,
  inferResumeBatchFromBalances,
} from '../src/chains/solana/transfer.js';

describe('estimateTransferFee', () => {
  it('matches the current default route fee', () => {
    const estimate = estimateTransferFee({ hopCount: 10, batchSize: 5 });

    assert.equal(estimate.totalHops, 11);
    assert.equal(estimate.batchCount, 3);
    assert.equal(estimate.signatureCount, 13);
    assert.equal(estimate.feeLamports, 65_000);
    assert.equal(estimate.feeSol, 65_000 / LAMPORTS_PER_SOL);
  });
});

describe('Solana RPC defaults', () => {
  it('keeps the web UI default endpoint aligned with the core default', () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const match = html.match(/<select id="solRpcUrl"[\s\S]*?<option value="([^"]+)"/);

    assert.equal(match?.[1], PUBLIC_RPCS[0]);
  });
});

describe('confirmSolanaTransaction', () => {
  it('accepts a finalized signature when the RPC confirmation call reports expiry', async () => {
    let statusChecked = false;
    const connection = {
      async confirmTransaction() {
        throw new Error('Signature abc has expired: block height exceeded.');
      },
      async getSignatureStatuses(signatures: string[], config: { searchTransactionHistory: boolean }) {
        statusChecked = true;
        assert.deepEqual(signatures, ['abc']);
        assert.equal(config.searchTransactionHistory, true);
        return {
          value: [{
            err: null,
            confirmationStatus: 'finalized',
          }],
        };
      },
    };

    const confirmation = await confirmSolanaTransaction(
      connection as any,
      { signature: 'abc', blockhash: 'blockhash', lastValidBlockHeight: 123 },
    );

    assert.equal(statusChecked, true);
    assert.equal(confirmation.value.err, null);
  });

  it('throws when the post-expiry signature status contains an on-chain error', async () => {
    const connection = {
      async confirmTransaction() {
        throw new Error('Signature abc has expired: block height exceeded.');
      },
      async getSignatureStatuses() {
        return {
          value: [{
            err: { InstructionError: [0, 'Custom'] },
            confirmationStatus: 'finalized',
          }],
        };
      },
    };

    await assert.rejects(
      () => confirmSolanaTransaction(
        connection as any,
        { signature: 'abc', blockhash: 'blockhash', lastValidBlockHeight: 123 },
      ),
      /failed after confirmation lookup/,
    );
  });

  it('keeps checking briefly when an expired signature is not visible immediately', async () => {
    let checks = 0;
    const connection = {
      async confirmTransaction() {
        throw new Error('Signature abc has expired: block height exceeded.');
      },
      async getSignatureStatuses() {
        checks += 1;
        return {
          value: [checks < 3 ? null : {
            err: null,
            confirmationStatus: 'confirmed',
          }],
        };
      },
    };

    const confirmation = await confirmSolanaTransaction(
      connection as any,
      { signature: 'abc', blockhash: 'blockhash', lastValidBlockHeight: 123 },
      'confirmed',
      { maxStatusChecks: 3, statusCheckDelayMs: 0 },
    );

    assert.equal(checks, 3);
    assert.equal(confirmation.value.err, null);
  });
});

describe('inferResumeBatchFromBalances', () => {
  it('advances to the batch that starts from the funded intermediate wallet', () => {
    const startBatch = inferResumeBatchFromBalances({
      intermediateBalances: [0, 0, 0, 0, 300_000_000, 0, 0, 0, 0, 0],
      amountLamports: 300_000_000,
      hopCount: 10,
      batchSize: 5,
    });

    assert.equal(startBatch, 1);
  });

  it('does not advance when no intermediate wallet holds the route amount', () => {
    const startBatch = inferResumeBatchFromBalances({
      intermediateBalances: [0, 0, 0, 0, 299_999_999],
      amountLamports: 300_000_000,
      hopCount: 10,
      batchSize: 5,
    });

    assert.equal(startBatch, 0);
  });
});

describe('recoverable route helpers', () => {
  it('creates a route that can be hydrated from encrypted recovery data', async () => {
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey.toBase58();
    const route = createRecoverableRoute({
      sourcePublicKey: source,
      destinationAddress: destination,
      hopCount: 4,
    });

    const bundle = await encryptRecoveryBundle({
      password: 'correct horse battery staple',
      route,
      amount: 0.1,
      batchSize: 2,
      rpcUrl: 'https://api.devnet.solana.com',
    });
    const restored = await decryptRecoveryBundle(bundle, 'correct horse battery staple');
    const hydrated = hydrateIntermediateKeypairs(restored);

    assert.equal(restored.version, 1);
    assert.equal(restored.sourceAddress, source.toBase58());
    assert.equal(restored.destinationAddress, destination);
    assert.equal(restored.hopCount, 4);
    assert.equal(hydrated.length, 4);
    assert.deepEqual(
      hydrated.map((keypair) => keypair.publicKey.toBase58()),
      route.intermediateKeypairs.map((keypair) => keypair.publicKey.toBase58()),
    );
  });

  it('calculates the next unfinished batch from completed progress', () => {
    assert.deepEqual(getBatchRange({ batchIndex: 0, hopCount: 10, batchSize: 5 }), {
      hopStart: 0,
      hopEnd: 5,
    });
    assert.deepEqual(getBatchRange({ batchIndex: 2, hopCount: 10, batchSize: 5 }), {
      hopStart: 10,
      hopEnd: 11,
    });
  });

  it('builds a recovery transaction that leaves fee lamports behind', () => {
    const intermediate = Keypair.generate();
    const destination = Keypair.generate().publicKey;
    const tx = buildRecoveryTransaction({
      fromKeypair: intermediate,
      toPublicKey: destination,
      balanceLamports: 1_000_000,
      recentBlockhash: PublicKey.default.toBase58(),
    });

    assert.equal(tx.feePayer?.toBase58(), intermediate.publicKey.toBase58());
    assert.equal(tx.signatures.length, 1);
    assert.ok(tx.serialize().length > 0);
  });
});
