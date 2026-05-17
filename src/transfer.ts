import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { StealthTransferOptions, BatchResult, TransferSummary } from './types.js';
import { createConnection } from './rpc.js';

/** Solana rent-exempt minimum for a 0-byte account (basic wallet). */
const RENT_EXEMPT_MIN_LAMPORTS = 890_880;
/** Maximum serialized transaction size allowed by Solana. */
const MAX_TX_SIZE = 1232;
/** Base fee per signature. */
const LAMPORTS_PER_SIG = 5000;

const RECOVERY_BUNDLE_VERSION = 1;
const RECOVERY_KDF_ITERATIONS = 250_000;

export type ProgressEvent = {
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
  data?: Record<string, unknown>;
};

export type ProgressHandler = (event: ProgressEvent) => void;

export type FeeEstimate = {
  totalHops: number;
  batchCount: number;
  signatureCount: number;
  feeLamports: number;
  feeSol: number;
};

export type RecoverableRoute = {
  sourcePublicKey: string;
  destinationAddress: string;
  hopCount: number;
  intermediateKeypairs: Keypair[];
  routePublicKeys: string[];
};

export type RecoveryPayload = {
  sourcePublicKey: string;
  destinationAddress: string;
  routePublicKeys: string[];
  intermediateSecretKeys: string[];
  amount: number;
  hopCount: number;
  batchSize: number;
  rpcUrl: string;
  lastCompletedBatch: number;
  transactions: string[];
};

export type RecoveryBundle = {
  version: 1;
  createdAt: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type DecryptedRecoveryBundle = RecoveryPayload & {
  version: 1;
  createdAt: string;
};

export function generateIntermediateWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveRecoveryKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: RECOVERY_KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function estimateTransferFee({
  hopCount,
  batchSize,
}: {
  hopCount: number;
  batchSize: number;
}): FeeEstimate {
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
}): Promise<RecoveryBundle> {
  if (password.length < 8) {
    throw new Error('Recovery password must be at least 8 characters.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveRecoveryKey(password, salt);
  const payload: RecoveryPayload = {
    sourcePublicKey: route.sourcePublicKey,
    destinationAddress: route.destinationAddress,
    routePublicKeys: route.routePublicKeys,
    intermediateSecretKeys: route.intermediateKeypairs.map((keypair) =>
      bytesToBase64(keypair.secretKey),
    ),
    amount,
    hopCount: route.hopCount,
    batchSize,
    rpcUrl,
    lastCompletedBatch,
    transactions,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoded),
  );

  return {
    version: RECOVERY_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    kdf: 'PBKDF2-SHA256',
    iterations: RECOVERY_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptRecoveryBundle(
  bundle: RecoveryBundle,
  password: string,
): Promise<DecryptedRecoveryBundle> {
  if (bundle.version !== RECOVERY_BUNDLE_VERSION) {
    throw new Error(`Unsupported recovery bundle version: ${bundle.version}`);
  }

  const salt = base64ToBytes(bundle.salt);
  const iv = base64ToBytes(bundle.iv);
  const key = await deriveRecoveryKey(password, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(base64ToBytes(bundle.ciphertext)),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as RecoveryPayload;
  return {
    version: bundle.version,
    createdAt: bundle.createdAt,
    ...payload,
  };
}

export function hydrateIntermediateKeypairs(bundle: DecryptedRecoveryBundle): Keypair[] {
  return bundle.intermediateSecretKeys.map((secretKey) =>
    Keypair.fromSecretKey(base64ToBytes(secretKey)),
  );
}

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
      txSignature: signature,
      hopStart: index,
      hopEnd: index + 1,
      feeLamports: LAMPORTS_PER_SIG,
    });
    onProgress?.({
      type: 'success',
      message: `Recovered ${balance.publicKey.toBase58().slice(0, 8)}…`,
      data: { txUrl: `https://solscan.io/tx/${signature}` },
    });
  }

  return results;
}

/**
 * Build and sign one batch of chained transfers as a single atomic transaction.
 *
 * Atomic batch mechanism:
 *   [W_start] → [W_start+1] → ... → [W_end]
 *
 * Each intermediate receives `amountLamports` (>> rent-exempt minimum),
 * then forwards it all — ending at 0, garbage collected.
 * Source signs every batch as fee payer so no fee is deducted from intermediates.
 */
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

/**
 * Execute a stealth transfer routing SOL through N intermediate wallets.
 *
 * @param options  Transfer parameters
 * @param onProgress  Optional callback for web UI progress updates
 * @returns Transfer summary
 */
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

  // ─── Validation ───────────────────────────────────────────────────────────

  if (amountLamports < RENT_EXEMPT_MIN_LAMPORTS) {
    throw new Error(
      `Minimum amount for stealth transfer is ~0.00089088 SOL (rent-exempt threshold). ` +
      `Got ${amount} SOL.`,
    );
  }

  // totalHops = Source→W1 + W1→W2 + ... + W{N-1}→Destination = hopCount + 1
  const { totalHops, batchCount, feeLamports: estimatedFee } = estimateTransferFee({
    hopCount,
    batchSize,
  });
  const totalNeeded = amountLamports + estimatedFee;

  // Check balance
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

  // Route: [Source, W0, W1, ..., W{N-1}, Destination]
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

  // ─── Execute batches ──────────────────────────────────────────────────────

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
    results.push({ txSignature: signature, hopStart, hopEnd, feeLamports: feePaid });
    await options.onBatchConfirmed?.({
      lastCompletedBatch: b,
      nextBatch: b + 1,
      txSignature: signature,
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

  // ─── Summary ──────────────────────────────────────────────────────────────

  const totalFeeLamports = results.reduce((s, r) => s + r.feeLamports, 0);
  const destBalance = await connection.getBalance(destinationPubkey);

  emit('success', `Transfer complete`);
  emit('info', `Destination balance: ${(destBalance / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  emit('info', `Network fee: ${(totalFeeLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL ` +
    `(vs tokentools 0.005 SOL = ${(0.005 / (totalFeeLamports / LAMPORTS_PER_SOL)).toFixed(0)}× markup)`);

  return {
    batches: results,
    totalFeeLamports,
    totalFeeSol: totalFeeLamports / LAMPORTS_PER_SOL,
    amountTransferred: amount,
    hopCount,
    batchCount,
    intermediateWallets: intermediates.map((k) => k.publicKey),
    success: true,
  };
}
