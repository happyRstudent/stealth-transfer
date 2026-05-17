/** Supported chain identifiers. */
export type ChainId = 'solana' | 'eth' | 'bsc' | 'base';

/** EVM-specific chain config. */
export interface EvmChainConfig {
  id: ChainId;
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  publicRpcs: string[];
  explorerUrl: string;
}

/** Progress of a batch confirmation (chain-agnostic). */
export interface TransferProgress {
  lastCompletedBatch: number;
  nextBatch: number;
  txHash: string;
  updatedAt: string;
}

/** Result of one batch (Solana: one tx = N hops; EVM: N txs = N hops). */
export interface BatchResult {
  txHashes: string[];
  hopStart: number;
  hopEnd: number;
  fee: string; // human-readable, e.g. "0.00042 ETH"
}

/** Final summary returned after a full transfer. */
export interface TransferSummary {
  batches: BatchResult[];
  totalFee: string; // human-readable
  amountTransferred: number;
  hopCount: number;
  batchCount: number;
  intermediateAddresses: string[];
  success: boolean;
}

// ─── Recovery types (chain-agnostic) ─────────────────────────────────────

export interface RecoveryPayload {
  chain: ChainId;
  sourceAddress: string;
  destinationAddress: string;
  routeAddresses: string[];
  intermediateSecretKeys: string[]; // base64-encoded raw private keys
  amount: number;
  hopCount: number;
  batchSize: number;
  rpcUrl: string;
  lastCompletedBatch: number;
  transactions: string[];
}

export interface RecoveryBundle {
  version: 1;
  createdAt: string;
  chain: ChainId;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface DecryptedRecoveryBundle extends RecoveryPayload {
  version: 1;
  createdAt: string;
  chain: ChainId;
}

/** Direction for recovery sweep. */
export type RecoveryAction = 'continue' | 'sweep' | 'refund';
