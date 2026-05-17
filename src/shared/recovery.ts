import {
  bytesToBase64,
  base64ToBytes,
  toArrayBuffer,
  deriveRecoveryKey,
  RECOVERY_BUNDLE_VERSION,
} from './crypto.js';
import type {
  ChainId,
  RecoveryPayload,
  RecoveryBundle,
  DecryptedRecoveryBundle,
} from './types.js';

export interface EncryptRecoveryBundleParams {
  password: string;
  chain: ChainId;
  sourceAddress: string;
  destinationAddress: string;
  routeAddresses: string[];
  intermediateSecretKeys: string[]; // base64-encoded
  amount: number;
  batchSize: number;
  rpcUrl: string;
  lastCompletedBatch?: number;
  transactions?: string[];
}

export async function encryptRecoveryBundle({
  password,
  chain,
  sourceAddress,
  destinationAddress,
  routeAddresses,
  intermediateSecretKeys,
  amount,
  batchSize,
  rpcUrl,
  lastCompletedBatch = -1,
  transactions = [],
}: EncryptRecoveryBundleParams): Promise<RecoveryBundle> {
  if (password.length < 8) {
    throw new Error('Recovery password must be at least 8 characters.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveRecoveryKey(password, salt);

  const payload: RecoveryPayload = {
    chain,
    sourceAddress,
    destinationAddress,
    routeAddresses,
    intermediateSecretKeys,
    amount,
    hopCount: routeAddresses.length - 2, // exclude source and destination
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
    chain,
    kdf: 'PBKDF2-SHA256',
    iterations: 250_000,
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
  if (payload.chain !== bundle.chain) {
    throw new Error('Recovery bundle chain metadata does not match encrypted payload.');
  }

  return {
    ...payload,
    version: bundle.version,
    createdAt: bundle.createdAt,
  };
}
