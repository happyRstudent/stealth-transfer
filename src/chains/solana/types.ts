import type { Keypair, PublicKey } from '@solana/web3.js';
import type { TransferProgress } from '../../shared/types.js';

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

export interface SolanaFeeEstimate {
  totalHops: number;
  batchCount: number;
  signatureCount: number;
  feeLamports: number;
  feeSol: number;
}

export interface RecoverableRoute {
  sourcePublicKey: string;
  destinationAddress: string;
  hopCount: number;
  intermediateKeypairs: Keypair[];
  routePublicKeys: string[];
}
