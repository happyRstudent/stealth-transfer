import { Connection } from '@solana/web3.js';

/**
 * Create a Solana connection with configurable options.
 * Supports public RPCs and private endpoints.
 */
export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 120_000,
  });
}

/**
 * List of reliable public Solana RPC endpoints.
 */
export const PUBLIC_RPCS = [
  'https://api.mainnet.solana.com',
  'https://api.devnet.solana.com',
  'https://api.testnet.solana.com',
];

/**
 * Test an RPC endpoint by fetching the slot number.
 * Returns latency in ms, or -1 if unreachable.
 */
export async function testRpcLatency(rpcUrl: string, timeoutMs = 5000): Promise<number> {
  const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
  const start = Date.now();
  try {
    await conn.getSlot();
    return Date.now() - start;
  } catch {
    return -1;
  }
}
