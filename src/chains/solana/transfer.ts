import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { createConnection } from './rpc.js';
import type { StealthTransferOptions, SolanaFeeEstimate, RecoverableRoute } from './types.js';
import type { BatchResult, TransferSummary, TransferProgress } from '../../shared/types.js';
import {
  bytesToBase64,
  encryptRecoveryBundle as encryptBundle,
  decryptRecoveryBundle as decryptBundle,
} from '../../shared/index.js';
import type { DecryptedRecoveryBundle } from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════

const RENT_EXEMPT_MIN_LAMPORTS = 890_880;
const MAX_TX_SIZE = 1232;
const LAMPORTS_PER_SIG = 5000;

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

export type ProgressEvent = {
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
  data?: Record<string, unknown>;
};

export type ProgressHandler = (event: ProgressEvent) => void;

export type {
  SolanaFeeEstimate as FeeEstimate,
  RecoverableRoute,
} from './types.js';
export type {
  TransferSummary,
  BatchResult,
  TransferProgress,
  DecryptedRecoveryBundle,
} from '../../shared/types.js';
export type { RecoveryBundle } from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Wallet generation
// ═══════════════════════════════════════════════════════════════════════════

export function generateIntermediateWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

// ═══════════════════════════════════════════════════════════════════════════
//  Fee estimation
// ═══════════════════════════════════════════════════════════════════════════

export function getBatchRange({
  batchIndex,
  hopCount,
  batchSize,
}: {
  batchIndex: number;
  hopCount: number;
  batchSize: number;
}): { hopStart: number; hopEnd: number } {
  const totalHops = hopCount + 1;
  const hopStart = batchIndex * batchSize;
  return {
    hopStart,
    hopEnd: Math.min(hopStart + batchSize, totalHops),
  };
}

export function estimateTransferFee({
  hopCount,
  batchSize,
}: {
  hopCount: number;
  batchSize: number;
}): SolanaFeeEstimate {
  const totalHops = hopCount + 1;
  const batchCount = Math.ceil(totalHops / batchSize);
  let signatureCount = 0;

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const { hopStart, hopEnd } = getBatchRange({ batchIndex, hopCount, batchSize });
    const hops = hopEnd - hopStart;
    signatureCount += hopStart === 0 ? hops : hops + 1;
  }

  const feeLamports = signatureCount * LAMPORTS_PER_SIG;
  return {
    totalHops,
    batchCount,
    signatureCount,
    feeLamports,
    feeSol: feeLamports / LAMPORTS_PER_SOL,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Route management
// ═══════════════════════════════════════════════════════════════════════════

export function createRecoverableRoute({
  sourcePublicKey,
  destinationAddress,
  hopCount,
}: {
  sourcePublicKey: PublicKey;
  destinationAddress: string;
  hopCount: number;
}): RecoverableRoute {
  const intermediateKeypairs = generateIntermediateWallets(hopCount);
  return {
    sourcePublicKey: sourcePublicKey.toBase58(),
    destinationAddress,
    hopCount,
    intermediateKeypairs,
    routePublicKeys: [
      sourcePublicKey.toBase58(),
      ...intermediateKeypairs.map((keypair) => keypair.publicKey.toBase58()),
      destinationAddress,
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Recovery encryption / decryption (Solana wrappers)
// ═══════════════════════════════════════════════════════════════════════════

export async function encryptRecoveryBundle({
  password,
  route,
  amount,
  batchSize,
  rpcUrl,
  lastCompletedBatch = -1,
  transactions = [],
}: {
  password: string;
  route: RecoverableRoute;
  amount: number;
  batchSize: number;
  rpcUrl: string;
  lastCompletedBatch?: number;
  transactions?: string[];
}) {
  return encryptBundle({
    password,
    chain: 'solana',
    sourceAddress: route.sourcePublicKey,
    destinationAddress: route.destinationAddress,
    routeAddresses: route.routePublicKeys,
    intermediateSecretKeys: route.intermediateKeypairs.map((keypair) =>
      bytesToBase64(keypair.secretKey),
    ),
    amount,
    batchSize,
    rpcUrl,
    lastCompletedBatch,
    transactions,
  });
}

export async function decryptRecoveryBundle(
  bundle: Parameters<typeof decryptBundle>[0],
  password: string,
) {
  const result = await decryptBundle(bundle, password);
  // Backward compat: old bundles may not have `chain`
  if (!result.chain) (result as any).chain = 'solana';
  return result;
}

export function hydrateIntermediateKeypairs(bundle: DecryptedRecoveryBundle): Keypair[] {
  return bundle.intermediateSecretKeys.map((secretKey) => {
    // secretKey is base64-encoded 64-byte Solana secret key
    const binary = atob(secretKey);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Keypair.fromSecretKey(bytes);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Recovery transactions
// ═══════════════════════════════════════════════════════════════════════════

export function buildRecoveryTransaction({
  fromKeypair,
  toPublicKey,
  balanceLamports,
  recentBlockhash,
}: {
  fromKeypair: Keypair;
  toPublicKey: PublicKey;
  balanceLamports: number;
  recentBlockhash: string;
}): Transaction {
  const transferableLamports = balanceLamports - LAMPORTS_PER_SIG;
  if (transferableLamports <= 0) {
    throw new Error('Intermediate wallet balance is too small to recover after network fee.');
  }

  const tx = new Transaction();
  tx.feePayer = fromKeypair.publicKey;
  tx.recentBlockhash = recentBlockhash;
  tx.add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: transferableLamports,
    }),
  );
  tx.sign(fromKeypair);
  return tx;
}

export async function scanIntermediateBalances(
  connection: Connection,
  intermediateKeypairs: Keypair[],
): Promise<Array<{ publicKey: PublicKey; balanceLamports: number }>> {
  const balances = await Promise.all(
    intermediateKeypairs.map(async (keypair) => ({
      publicKey: keypair.publicKey,
      balanceLamports: await connection.getBalance(keypair.publicKey),
    })),
  );
  return balances.filter((entry) => entry.balanceLamports > LAMPORTS_PER_SIG);
}

export async function recoverIntermediateBalances({
  rpcUrl,
  intermediateKeypairs,
  targetAddress,
  onProgress,
}: {
  rpcUrl: string;
  intermediateKeypairs: Keypair[];
  targetAddress: string;
  onProgress?: ProgressHandler;
}): Promise<BatchResult[]> {
  const connection = createConnection(rpcUrl);
  const targetPublicKey = new PublicKey(targetAddress);
  const balances = await scanIntermediateBalances(connection, intermediateKeypairs);
  const results: BatchResult[] = [];

  for (let index = 0; index < balances.length; index++) {
    const balance = balances[index];
    const fromKeypair = intermediateKeypairs.find((keypair) =>
      keypair.publicKey.equals(balance.publicKey),
    );
    if (!fromKeypair) continue;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = buildRecoveryTransaction({
      fromKeypair,
      toPublicKey: targetPublicKey,
      balanceLamports: balance.balanceLamports,
      recentBlockhash: blockhash,
    });

    onProgress?.({
      type: 'info',
      message: `Recovering ${balance.publicKey.toBase58().slice(0, 8)}…`,
    });

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    if (confirmation.value.err) {
      throw new Error(`Recovery transfer failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    results.push({
      txHashes: [signature],
      hopStart: index,
      hopEnd: index + 1,
      fee: `${LAMPORTS_PER_SIG / LAMPORTS_PER_SOL} SOL`,
    });
    onProgress?.({
      type: 'success',
      message: `Recovered ${balance.publicKey.toBase58().slice(0, 8)}…`,
      data: { txUrl: `https://solscan.io/tx/${signature}` },
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Atomic batch builder
// ═══════════════════════════════════════════════════════════════════════════

function buildAndSignBatch(
  wallets: PublicKey[],
  hopStart: number,
  hopEnd: number,
  amountLamports: number,
  sourceKeypair: Keypair,
  intermediateKeypairs: Keypair[],
  blockhash: string,
): Transaction {
  const tx = new Transaction();
  tx.feePayer = sourceKeypair.publicKey;
  tx.recentBlockhash = blockhash;

  for (let i = hopStart; i < hopEnd; i++) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallets[i],
        toPubkey: wallets[i + 1],
        lamports: amountLamports,
      }),
    );
  }

  // Signers: Source (fee payer) + every intermediate that acts as a sender in this batch
  const signers: Keypair[] = [sourceKeypair];
  for (let i = hopStart; i < hopEnd; i++) {
    if (i > 0) {
      signers.push(intermediateKeypairs[i - 1]);
    }
  }

  tx.sign(...signers);
  return tx;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Execute stealth transfer
// ═══════════════════════════════════════════════════════════════════════════

export async function executeStealthTransfer(
  options: StealthTransferOptions,
  onProgress?: ProgressHandler,
): Promise<TransferSummary> {
  const { sourceKeypair, destinationAddress, hopCount, amount, rpcUrl, delayMs, batchSize } =
    options;
  const startBatch = options.startBatch ?? 0;

  const connection = createConnection(rpcUrl);
  const destinationPubkey = new PublicKey(destinationAddress);
  const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);

  // ─── Validation ─────────────────────────────────────────────────────────

  if (amountLamports < RENT_EXEMPT_MIN_LAMPORTS) {
    throw new Error(
      `Minimum amount for stealth transfer is ~0.00089088 SOL (rent-exempt threshold). ` +
      `Got ${amount} SOL.`,
    );
  }

  const { totalHops, batchCount, feeLamports: estimatedFee } = estimateTransferFee({
    hopCount,
    batchSize,
  });
  const totalNeeded = amountLamports + estimatedFee;

  const sourceBalance = await connection.getBalance(sourceKeypair.publicKey);
  if (sourceBalance < totalNeeded) {
    throw new Error(
      `Insufficient balance. Need ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(9)} SOL ` +
      `(transfer ${amount} SOL + fees ${(estimatedFee / LAMPORTS_PER_SOL).toFixed(9)} SOL) ` +
      `but source has ${(sourceBalance / LAMPORTS_PER_SOL).toFixed(9)} SOL.`,
    );
  }

  const intermediates = options.intermediateKeypairs ?? generateIntermediateWallets(hopCount);
  if (intermediates.length !== hopCount) {
    throw new Error(`Expected ${hopCount} intermediate wallets, got ${intermediates.length}.`);
  }
  if (startBatch < 0 || startBatch >= batchCount) {
    throw new Error(`Start batch must be between 0 and ${batchCount - 1}.`);
  }

  const wallets: PublicKey[] = [
    sourceKeypair.publicKey,
    ...intermediates.map((k) => k.publicKey),
    destinationPubkey,
  ];

  const emit = (type: ProgressEvent['type'], message: string, data?: Record<string, unknown>) => {
    const event = { type, message, data };
    onProgress?.(event);
    if (type === 'info') console.log(`   ${message}`);
    else if (type === 'success') console.log(`   ✅ ${message}`);
    else if (type === 'error') console.log(`   ❌ ${message}`);
    else if (type === 'warn') console.log(`   ⚠️ ${message}`);
  };

  emit('info', `Route: ${sourceKeypair.publicKey.toBase58().slice(0, 8)}… → ` +
    `${hopCount} hops → ${destinationAddress.slice(0, 8)}…`);
  emit('info', `Batches: ${batchCount} × ${batchSize} hops/tx`);

  if (delayMs > 0) {
    emit('info', `Delay: ${delayMs}ms (random jitter between batches)`);
  }

  // ─── Execute batches ────────────────────────────────────────────────────

  const results: BatchResult[] = [];

  for (let b = startBatch; b < batchCount; b++) {
    const { hopStart, hopEnd } = getBatchRange({ batchIndex: b, hopCount, batchSize });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const tx = buildAndSignBatch(
      wallets, hopStart, hopEnd, amountLamports,
      sourceKeypair, intermediates, blockhash,
    );

    const rawTx = tx.serialize();
    if (rawTx.length > MAX_TX_SIZE) {
      throw new Error(
        `Transaction too large: ${rawTx.length} bytes (max ${MAX_TX_SIZE}). ` +
        `Reduce --batch-size (currently ${batchSize}).`,
      );
    }

    emit('info', `Batch ${b + 1}/${batchCount} — ` +
      `hops ${hopStart}–${hopEnd - 1} [${rawTx.length}B, ${tx.signatures.length} sigs]`);

    const signature = await connection.sendRawTransaction(rawTx, { skipPreflight: false });

    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    if (confirmation.value.err) {
      emit('error', `Batch ${b + 1} failed: ${JSON.stringify(confirmation.value.err)}`);
      throw new Error(`Batch ${b + 1} failed.`);
    }

    const feePaid = tx.signatures.length * LAMPORTS_PER_SIG;
    results.push({
      txHashes: [signature],
      hopStart,
      hopEnd,
      fee: `${(feePaid / LAMPORTS_PER_SOL).toFixed(9)} SOL`,
    });
    await options.onBatchConfirmed?.({
      lastCompletedBatch: b,
      nextBatch: b + 1,
      txHash: signature,
      updatedAt: new Date().toISOString(),
    });

    emit('success', `Batch ${b + 1} confirmed`, { txUrl: `https://solscan.io/tx/${signature}` });
    emit('info', `  Fee: ${(feePaid / LAMPORTS_PER_SOL).toFixed(9)} SOL`);

    // Privacy delay between batches
    if (b < batchCount - 1 && delayMs > 0) {
      const jitter = Math.floor(Math.random() * delayMs);
      emit('info', `Waiting ${(jitter / 1000).toFixed(1)}s…`);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  const totalFeeLamports = results.reduce((s, r) => {
    const parsed = parseFloat(r.fee);
    return s + (isNaN(parsed) ? 0 : parsed * LAMPORTS_PER_SOL);
  }, 0);
  const destBalance = await connection.getBalance(destinationPubkey);

  emit('success', `Transfer complete`);
  emit('info', `Destination balance: ${(destBalance / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  emit('info', `Network fee: ${(totalFeeLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`);

  return {
    batches: results,
    totalFee: `${(totalFeeLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`,
    amountTransferred: amount,
    hopCount,
    batchCount,
    intermediateAddresses: intermediates.map((k) => k.publicKey.toBase58()),
    success: true,
  };
}
