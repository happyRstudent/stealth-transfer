import { Keypair, PublicKey } from '@solana/web3.js';

export interface StealthTransferOptions {
  sourceKeypair: Keypair;
  destinationAddress: string;
  hopCount: number;
  amount: number; // in SOL
  rpcUrl: string;
  delayMs: number;
  batchSize: number;
  intermediateKeypairs?: Keypair[];
  startBatch?: number;
  onBatchConfirmed?: (progress: TransferProgress) => void | Promise<void>;
}

export interface BatchResult {
  txSignature: string;
  hopStart: number;
  hopEnd: number;
  feeLamports: number;
}

export interface TransferSummary {
  batches: BatchResult[];
  totalFeeLamports: number;
  totalFeeSol: number;
  amountTransferred: number; // SOL
  hopCount: number;
  batchCount: number;
  intermediateWallets: PublicKey[];
  success: boolean;
}

export interface TransferProgress {
  lastCompletedBatch: number;
  nextBatch: number;
  txSignature: string;
  updatedAt: string;
}
