import { createPublicClient, http, type PublicClient } from 'viem';
import * as chains from 'viem/chains';
import type { EvmChainId, EvmGasConfig } from './types.js';

/** Per-chain gas configuration. */
export const EVM_GAS_CONFIGS: Record<EvmChainId, EvmGasConfig> = {
  eth:   { gasLimit: 21000n, gasBufferMultiplier: 1.5, minGasBuffer: 1_000_000_000_000_000n }, // 0.001 ETH
  bsc:   { gasLimit: 21000n, gasBufferMultiplier: 1.2, minGasBuffer: 100_000_000_000_000n },     // 0.0001 BNB
  base:  { gasLimit: 21000n, gasBufferMultiplier: 1.5, minGasBuffer: 100_000_000_000_000n },     // 0.0001 ETH
};

/** Public RPC endpoints for each supported EVM chain. */
export const EVM_PUBLIC_RPCS: Record<EvmChainId, string[]> = {
  eth: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://rpc.flashbots.net',
  ],
  bsc: [
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed2.ninicoin.io',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
  ],
};

/** Explorer URL templates for each chain. */
export const EVM_EXPLORERS: Record<EvmChainId, string> = {
  eth:  'https://etherscan.io/tx/',
  bsc:  'https://bscscan.com/tx/',
  base: 'https://basescan.org/tx/',
};

/** viem chain objects keyed by our EvmChainId. */
const VIEM_CHAINS: Record<EvmChainId, chains.Chain> = {
  eth:  chains.mainnet,
  bsc:  chains.bsc,
  base: chains.base,
};

/**
 * Create a viem PublicClient for the given chain and RPC URL.
 */
export function createEvmClient(chainId: EvmChainId, rpcUrl: string): PublicClient {
  const chain: chains.Chain = {
    ...VIEM_CHAINS[chainId],
    // Override default RPCs with the user-provided one
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  };

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Test an EVM RPC endpoint by fetching the block number.
 * Returns latency in ms, or -1 if unreachable.
 */
export async function testEvmRpcLatency(
  chainId: EvmChainId,
  rpcUrl: string,
  timeoutMs = 5000,
): Promise<number> {
  try {
    const client = createEvmClient(chainId, rpcUrl);
    const start = Date.now();
    await Promise.race([
      client.getBlockNumber(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return Date.now() - start;
  } catch {
    return -1;
  }
}

/** Get the default (first) public RPC for a chain. */
export function getDefaultRpc(chainId: EvmChainId): string {
  return EVM_PUBLIC_RPCS[chainId][0];
}

/** Get the viem chain object for an EvmChainId. */
export function getViemChain(chainId: EvmChainId): chains.Chain {
  return VIEM_CHAINS[chainId];
}
