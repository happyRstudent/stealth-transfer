import type { ChainId, TransferProgress } from '../../shared/types.js';

/** EVM-specific chain identifiers. */
export type EvmChainId = 'eth' | 'bsc' | 'base';

/** Gas configuration for a chain. */
export interface EvmGasConfig {
  gasLimit: bigint;       // standard ETH transfer gas (21000)
  gasBufferMultiplier: number; // safety multiplier for gas price
  minGasBuffer: bigint;   // minimum gas buffer in wei (in case gas price is very low)
}

/** Options for an EVM stealth transfer. */
export interface EvmTransferOptions {
  sourcePrivateKey: string;   // 0x-prefixed hex
  destinationAddress: string; // 0x-prefixed hex
  chainId: EvmChainId;
  hopCount: number;
  amount: number;             // in native units (ETH / BNB)
  rpcUrl: string;
  delayMs: number;
  batchSize: number;
  intermediatePrivateKeys?: string[]; // 0x-prefixed hex, for recovery/continuation
  startHop?: number;          // resume from this hop index (0-based)
  onHopConfirmed?: (progress: TransferProgress) => void | Promise<void>;
}

/** A recoverable EVM route with intermediate wallets. */
export interface EvmRecoverableRoute {
  sourceAddress: string;
  destinationAddress: string;
  hopCount: number;
  intermediatePrivateKeys: string[]; // 0x-prefixed hex
  routeAddresses: string[];
}
