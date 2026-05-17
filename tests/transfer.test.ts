import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  buildRecoveryTransaction,
  createRecoverableRoute,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  estimateTransferFee,
  getBatchRange,
  hydrateIntermediateKeypairs,
} from '../src/transfer.js';

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
    assert.equal(restored.sourcePublicKey, source.toBase58());
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
