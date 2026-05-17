import {
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getViemChain, createEvmClient, EVM_GAS_CONFIGS, EVM_EXPLORERS } from './rpc.js';
import type { EvmTransferOptions, EvmRecoverableRoute, EvmChainId } from './types.js';
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

/** Standard ETH transfer gas limit. */
const TRANSFER_GAS = 21000n;

/** Default number of confirmation blocks to wait. */
const CONFIRMATION_BLOCKS = 2;

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

export type ProgressEvent = {
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
  data?: Record<string, unknown>;
};

export type ProgressHandler = (event: ProgressEvent) => void;

export type EvmFeeEstimate = {
  totalHops: number;
  batchCount: number;
  estimatedGasWei: bigint;
  estimatedGasEther: string;
};

export type { EvmTransferOptions, EvmRecoverableRoute, EvmChainId } from './types.js';
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

/**
 * Generate N random EVM private keys (0x-prefixed hex).
 * Uses WebCrypto under the hood via viem.
 */
export function generateEvmPrivateKeys(count: number): string[] {
  return Array.from({ length: count }, () => {
    // viem's generatePrivateKey uses crypto.getRandomValues internally
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

/** Derive address from a 0x-prefixed private key. */
export function addressFromPrivateKey(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}

/** Generate N intermediate wallets, returning { privateKeys, addresses }. */
export function generateIntermediateWallets(count: number): {
  privateKeys: string[];
  addresses: string[];
} {
  const privateKeys = generateEvmPrivateKeys(count);
  const addresses = privateKeys.map(addressFromPrivateKey);
  return { privateKeys, addresses };
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
  const totalHops = hopCount + 1; // +1 because source→W1 is hop 0
  const hopStart = batchIndex * batchSize;
  return {
    hopStart,
    hopEnd: Math.min(hopStart + batchSize, totalHops),
  };
}

export async function estimateTransferFee({
  chainId,
  rpcUrl,
  hopCount,
  batchSize,
}: {
  chainId: EvmChainId;
  rpcUrl: string;
  hopCount: number;
  batchSize: number;
}): Promise<EvmFeeEstimate> {
  const client = createEvmClient(chainId, rpcUrl);
  const gasPrice = await client.getGasPrice();
  const gasConfig = EVM_GAS_CONFIGS[chainId];
  const gasPerHop = TRANSFER_GAS * gasPrice * BigInt(Math.ceil(gasConfig.gasBufferMultiplier * 100)) / 100n;
  const totalGas = gasPerHop * BigInt(hopCount + 1);

  return {
    totalHops: hopCount + 1,
    batchCount: Math.ceil((hopCount + 1) / batchSize),
    estimatedGasWei: totalGas,
    estimatedGasEther: formatEther(totalGas),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Route management
// ═══════════════════════════════════════════════════════════════════════════

export function createEvmRecoverableRoute({
  sourceAddress,
  destinationAddress,
  hopCount,
}: {
  sourceAddress: string;
  destinationAddress: string;
  hopCount: number;
}): EvmRecoverableRoute {
  const { privateKeys } = generateIntermediateWallets(hopCount);
  const addresses = privateKeys.map(addressFromPrivateKey);
  return {
    sourceAddress,
    destinationAddress,
    hopCount,
    intermediatePrivateKeys: privateKeys,
    routeAddresses: [sourceAddress, ...addresses, destinationAddress],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Recovery encryption / decryption (EVM wrappers)
// ═══════════════════════════════════════════════════════════════════════════

export async function encryptRecoveryBundle({
  password,
  chainId,
  route,
  amount,
  batchSize,
  rpcUrl,
  lastCompletedBatch = -1,
  transactions = [],
}: {
  password: string;
  chainId: EvmChainId;
  route: EvmRecoverableRoute;
  amount: number;
  batchSize: number;
  rpcUrl: string;
  lastCompletedBatch?: number;
  transactions?: string[];
}) {
  // Encode 32-byte private keys as base64
  const intermediateSecretKeys = route.intermediatePrivateKeys.map((pk) => {
    const stripped = pk.startsWith('0x') ? pk.slice(2) : pk;
    const bytes = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(stripped.substring(i * 2, i * 2 + 2), 16);
    }
    return bytesToBase64(bytes);
  });

  return encryptBundle({
    password,
    chain: chainId,
    sourceAddress: route.sourceAddress,
    destinationAddress: route.destinationAddress,
    routeAddresses: route.routeAddresses,
    intermediateSecretKeys,
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
  if (!result.chain) (result as any).chain = 'eth';
  return result;
}

/** Convert base64-encoded private keys from a recovery bundle back to 0x hex strings. */
export function hydrateIntermediatePrivateKeys(bundle: DecryptedRecoveryBundle): string[] {
  return bundle.intermediateSecretKeys.map((secretKey) => {
    const binary = atob(secretKey);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Recovery: sweep intermediate balances
// ═══════════════════════════════════════════════════════════════════════════

export async function scanIntermediateBalances(
  client: PublicClient,
  addresses: string[],
): Promise<Array<{ address: string; balanceWei: bigint }>> {
  const balances = await Promise.all(
    addresses.map(async (address) => ({
      address,
      balanceWei: await client.getBalance({ address: address as `0x${string}` }),
    })),
  );
  // Only return addresses with non-zero balance
  return balances.filter((entry) => entry.balanceWei > 0n);
}

export async function recoverIntermediateBalances({
  chainId,
  rpcUrl,
  intermediatePrivateKeys,
  targetAddress,
  onProgress,
}: {
  chainId: EvmChainId;
  rpcUrl: string;
  intermediatePrivateKeys: string[];
  targetAddress: string;
  onProgress?: ProgressHandler;
}): Promise<BatchResult[]> {
  const publicClient = createEvmClient(chainId, rpcUrl);
  const chain = getViemChain(chainId);
  const addresses = intermediatePrivateKeys.map(addressFromPrivateKey);
  const balances = await scanIntermediateBalances(publicClient, addresses);
  const results: BatchResult[] = [];

  for (let index = 0; index < balances.length; index++) {
    const entry = balances[index];
    const pkIndex = addresses.findIndex(
      (addr) => addr.toLowerCase() === entry.address.toLowerCase(),
    );
    if (pkIndex === -1) continue;

    const privateKey = intermediatePrivateKeys[pkIndex];
    const walletClient = createWalletClient({
      chain,
      transport: http(rpcUrl),
      account: privateKeyToAccount(privateKey as `0x${string}`),
    });

    const gasPrice = await publicClient.getGasPrice();
    const gasCost = TRANSFER_GAS * gasPrice;

    if (entry.balanceWei <= gasCost) {
      onProgress?.({
        type: 'warn',
        message: `Skipping ${entry.address.slice(0, 10)}… — balance too low for gas`,
      });
      continue;
    }

    const value = entry.balanceWei - gasCost;

    onProgress?.({
      type: 'info',
      message: `Recovering ${formatEther(entry.balanceWei)} from ${entry.address.slice(0, 10)}…`,
    });

    const txHash = await walletClient.sendTransaction({
      to: targetAddress as `0x${string}`,
      value,
      gas: TRANSFER_GAS,
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: CONFIRMATION_BLOCKS,
    });

    if (receipt.status !== 'success') {
      throw new Error(`Recovery transfer failed: ${txHash}`);
    }

    results.push({
      txHashes: [txHash],
      hopStart: index,
      hopEnd: index + 1,
      fee: formatEther(gasCost),
    });

    onProgress?.({
      type: 'success',
      message: `Recovered ${entry.address.slice(0, 10)}…`,
      data: { txUrl: `${EVM_EXPLORERS[chainId]}${txHash}` },
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Execute EVM stealth transfer
// ═══════════════════════════════════════════════════════════════════════════

export async function executeEvmStealthTransfer(
  options: EvmTransferOptions,
  onProgress?: ProgressHandler,
): Promise<TransferSummary> {
  const {
    sourcePrivateKey,
    destinationAddress,
    chainId,
    hopCount,
    amount,
    rpcUrl,
    delayMs,
    batchSize,
    intermediatePrivateKeys: providedKeys,
    startHop = 0,
  } = options;

  const publicClient = createEvmClient(chainId, rpcUrl);
  const chain = getViemChain(chainId);
  const gasConfig = EVM_GAS_CONFIGS[chainId];
  const sourceAccount = privateKeyToAccount(sourcePrivateKey as `0x${string}`);
  const sourceAddress = sourceAccount.address;

  const amountWei = parseEther(amount.toString());
  const totalHops = hopCount + 1; // +1 for source→W1

  // Validate addresses (0x format, 42 chars)
  if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
    throw new Error('Invalid destination address. Expected 0x-prefixed hex (42 chars).');
  }

  // ─── Generate or use provided intermediate wallets ─────────────────────

  const intermediatePrivateKeys = providedKeys ?? generateEvmPrivateKeys(hopCount);
  if (intermediatePrivateKeys.length !== hopCount) {
    throw new Error(`Expected ${hopCount} intermediate wallets, got ${intermediatePrivateKeys.length}.`);
  }
  const intermediateAddresses = intermediatePrivateKeys.map(addressFromPrivateKey);

  // Full route: [Source, W0, W1, ..., W{N-1}, Destination]
  const allAddresses = [sourceAddress, ...intermediateAddresses, destinationAddress];
  // All private keys (source first, then intermediates)
  const allPrivateKeys = [sourcePrivateKey, ...intermediatePrivateKeys];

  // ─── Estimate total gas needed ─────────────────────────────────────────

  const gasPrice = await publicClient.getGasPrice();
  const gasPerHop = TRANSFER_GAS * gasPrice;
  const gasBufferPerHop =
    (gasPerHop * BigInt(Math.ceil(gasConfig.gasBufferMultiplier * 100))) / 100n;
  const effectiveBuffer = gasBufferPerHop > gasConfig.minGasBuffer
    ? gasBufferPerHop
    : gasConfig.minGasBuffer;
  const totalGasBuffer = effectiveBuffer * BigInt(totalHops);
  const totalNeeded = amountWei + totalGasBuffer;

  // Check source balance
  const sourceBalance = await publicClient.getBalance({ address: sourceAddress as `0x${string}` });
  if (sourceBalance < totalNeeded) {
    throw new Error(
      `Insufficient balance. Need ${formatEther(totalNeeded)} (${formatEther(amountWei)} + ` +
      `${formatEther(totalGasBuffer)} gas buffer) but source has ${formatEther(sourceBalance)}.`,
    );
  }

  const batchCount = Math.ceil(totalHops / batchSize);

  const emit = (type: ProgressEvent['type'], message: string, data?: Record<string, unknown>) => {
    const event = { type, message, data };
    onProgress?.(event);
    if (type === 'info') console.log(`   ${message}`);
    else if (type === 'success') console.log(`   ✅ ${message}`);
    else if (type === 'error') console.log(`   ❌ ${message}`);
    else if (type === 'warn') console.log(`   ⚠️ ${message}`);
  };

  emit('info', `Chain: ${chainId.toUpperCase()} | ${chain.name}`);
  emit('info', `Route: ${sourceAddress.slice(0, 10)}… → ${hopCount} hops → ${destinationAddress.slice(0, 10)}…`);
  emit('info', `Batches: ${batchCount} × ${batchSize} hops (${totalHops} total txs)`);
  emit('info', `Gas buffer/hop: ${formatEther(effectiveBuffer)}`);

  if (delayMs > 0) {
    emit('info', `Delay: ${delayMs}ms (random jitter between batches)`);
  }

  const results: BatchResult[] = [];
  let currentHop = startHop;

  // ─── Execute batches ────────────────────────────────────────────────────

  for (let b = 0; b < batchCount && currentHop < totalHops; b++) {
    const { hopStart, hopEnd } = getBatchRange({ batchIndex: b, hopCount, batchSize });
    const actualStart = Math.max(currentHop, hopStart);
    const actualEnd = hopEnd;
    const batchTxHashes: string[] = [];

    for (let h = actualStart; h < actualEnd; h++) {
      const fromAddress = allAddresses[h];
      const toAddress = allAddresses[h + 1];
      const fromPrivateKey = allPrivateKeys[h];

      // Get current balance of the sender
      const balance = await publicClient.getBalance({ address: fromAddress as `0x${string}` });

      // Calculate gas cost at current price
      const currentGasPrice = await publicClient.getGasPrice();
      const gasCost = (TRANSFER_GAS * currentGasPrice *
        BigInt(Math.ceil(gasConfig.gasBufferMultiplier * 100))) / 100n;

      if (balance <= gasCost) {
        throw new Error(
          `Insufficient balance at hop ${h} (${fromAddress.slice(0, 10)}…): ` +
          `balance ${formatEther(balance)} < gas ${formatEther(gasCost)}. ` +
          `Funds may be stranded — use the recovery bundle to sweep.`,
        );
      }

      // Send everything minus gas
      const value = balance - gasCost;
      const isLastHop = h === totalHops - 1;

      emit('info',
        `Batch ${b + 1}/${batchCount} Hop ${h + 1}/${totalHops}: ` +
        `${fromAddress.slice(0, 8)}… → ${toAddress.slice(0, 8)}… ` +
        `[${formatEther(value)}]`);

      const walletClient = createWalletClient({
        chain,
        transport: http(rpcUrl),
        account: privateKeyToAccount(fromPrivateKey as `0x${string}`),
      });

      const txHash = await walletClient.sendTransaction({
        to: toAddress as `0x${string}`,
        value,
        gas: TRANSFER_GAS,
      });

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: CONFIRMATION_BLOCKS,
      });

      if (receipt.status !== 'success') {
        emit('error', `Hop ${h + 1} failed: ${txHash}`);
        throw new Error(
          `Hop ${h + 1} failed. Recovery bundle can be used to sweep remaining funds. ` +
          `${EVM_EXPLORERS[chainId]}${txHash}`,
        );
      }

      batchTxHashes.push(txHash);
      emit('success', `Hop ${h + 1} confirmed`, {
        txUrl: `${EVM_EXPLORERS[chainId]}${txHash}`,
      });

      await options.onHopConfirmed?.({
        lastCompletedBatch: h,
        nextBatch: h + 1,
        txHash,
        updatedAt: new Date().toISOString(),
      });

      currentHop = h + 1;
    }

    results.push({
      txHashes: batchTxHashes,
      hopStart: actualStart,
      hopEnd: actualEnd,
      fee: `${formatEther(effectiveBuffer * BigInt(actualEnd - actualStart))}`,
    });

    // Privacy delay between batches
    if (b < batchCount - 1 && currentHop < totalHops && delayMs > 0) {
      const jitter = Math.floor(Math.random() * delayMs);
      emit('info', `Waiting ${(jitter / 1000).toFixed(1)}s…`);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  const destBalance = await publicClient.getBalance({
    address: destinationAddress as `0x${string}`,
  });

  const totalFeeWei = results.reduce((sum, r) => {
    // Parse fee from human-readable string back to wei
    return sum + parseEther(r.fee || '0');
  }, 0n);

  emit('success', `Transfer complete`);
  emit('info', `Destination balance: ${formatEther(destBalance)}`);

  return {
    batches: results,
    totalFee: formatEther(totalFeeWei),
    amountTransferred: amount,
    hopCount,
    batchCount,
    intermediateAddresses,
    success: true,
  };
}
