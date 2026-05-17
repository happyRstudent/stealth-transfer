#!/usr/bin/env node

import { Keypair } from '@solana/web3.js';
import { Command } from 'commander';
import bs58 from 'bs58';
import { executeStealthTransfer } from './chains/solana/transfer.js';
import { PUBLIC_RPCS as SOLANA_RPCS } from './chains/solana/rpc.js';
import { executeEvmStealthTransfer } from './chains/evm/transfer.js';
import { getDefaultRpc, EVM_PUBLIC_RPCS } from './chains/evm/rpc.js';
import type { EvmChainId } from './chains/evm/types.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

type ChainId = 'solana' | EvmChainId;
const VALID_CHAINS: ChainId[] = ['solana', 'eth', 'bsc', 'base'];

const CHAIN_LABELS: Record<ChainId, string> = {
  solana: 'SOL',
  eth: 'ETH',
  bsc: 'BNB',
  base: 'ETH',
};

const CHAIN_DEFAULTS: Record<ChainId, { rpc: string; batchSizeMax: number }> = {
  solana: { rpc: SOLANA_RPCS[0], batchSizeMax: 8 },
  eth:     { rpc: EVM_PUBLIC_RPCS.eth[0], batchSizeMax: 100 },
  bsc:     { rpc: EVM_PUBLIC_RPCS.bsc[0], batchSizeMax: 100 },
  base:    { rpc: EVM_PUBLIC_RPCS.base[0], batchSizeMax: 100 },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Key parsers
// ═══════════════════════════════════════════════════════════════════════════

function parseSolanaPrivateKey(input: string): Keypair {
  // Try base58 first
  try {
    const decoded = bs58.decode(input);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
  } catch { /* not base58 */ }

  // Try JSON array format [12, 34, 56, ...]
  try {
    const arr = JSON.parse(input);
    if (Array.isArray(arr) && arr.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch { /* not JSON */ }

  throw new Error(
    'Invalid Solana private key. Provide:\n' +
    '  - Base58-encoded secret key (64 bytes)\n' +
    '  - JSON array from Solana CLI (e.g., [1,2,3,...])',
  );
}

function parseEvmPrivateKey(input: string): string {
  const trimmed = input.trim();

  // Accept 0x-prefixed or raw hex
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return '0x' + trimmed;

  throw new Error(
    'Invalid EVM private key. Provide a 64-character hex string (with or without 0x prefix).',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Address validation / detection
// ═══════════════════════════════════════════════════════════════════════════

function detectAddressFormat(address: string): ChainId {
  // EVM: 0x + 40 hex chars
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return 'eth'; // generic EVM — caller should specify exact chain
  }
  // Solana: base58, 32-44 chars, no 0x
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return 'solana';
  }
  throw new Error(
    'Could not detect address format. Expected:\n' +
    '  - Solana: base58 string (32-44 characters)\n' +
    '  - EVM:    0x-prefixed hex (42 characters)',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Validators
// ═══════════════════════════════════════════════════════════════════════════

function parseAmount(value: string): number {
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) throw new Error('Amount must be a positive number');
  return n;
}

function parseIntOption(value: string, name: string, min: number, max: number): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const program = new Command();

  program
    .name('stealth-transfer')
    .description('Route native tokens through multiple intermediate wallets for privacy')
    .version('2.0.0')
    .requiredOption('-k, --key <private-key>', 'Source wallet private key')
    .requiredOption('-d, --destination <address>', 'Destination wallet address')
    .option('-c, --chain <chain>', 'Chain: solana | eth | bsc | base', 'solana')
    .option('-n, --hops <number>', 'Number of intermediate wallets (2-100)', '10')
    .option('-a, --amount <number>', 'Amount to transfer (native token)', '0.1')
    .option('-r, --rpc <url>', 'RPC URL (overrides default)')
    .option('--delay <ms>', 'Delay between batches in ms (0 = no delay)', '500')
    .option('--batch-size <number>', 'Hops per batch', '5');

  program.parse(process.argv);
  const opts = program.opts();

  try {
    // ── Validate chain ──────────────────────────────────────────────────
    const chain = opts.chain.toLowerCase() as ChainId;
    if (!VALID_CHAINS.includes(chain)) {
      throw new Error(`Unknown chain "${chain}". Valid options: ${VALID_CHAINS.join(', ')}`);
    }

    const defaults = CHAIN_DEFAULTS[chain];

    // ── Parse key ───────────────────────────────────────────────────────
    if (chain === 'solana') {
      parseSolanaPrivateKey(opts.key); // validate format
    } else {
      parseEvmPrivateKey(opts.key); // validate format
    }

    // ── Validate destination ────────────────────────────────────────────
    const detectedFormat = detectAddressFormat(opts.destination);
    if (chain === 'solana' && detectedFormat !== 'solana') {
      console.warn(`⚠️  Destination looks like an EVM address, but chain is solana.`);
    } else if (chain !== 'solana' && detectedFormat === 'solana') {
      console.warn(`⚠️  Destination looks like a Solana address, but chain is ${chain}.`);
    }

    const hopCount = parseIntOption(opts.hops, 'Hops', 2, 100);
    const amount = parseAmount(opts.amount);
    const rpcUrl = opts.rpc || defaults.rpc;
    const delayMs = parseInt(opts.delay, 10);
    const batchSizeMax = defaults.batchSizeMax;
    const batchSize = parseIntOption(opts.batchSize, 'Batch size', 1, batchSizeMax);

    const currencySymbol = CHAIN_LABELS[chain];

    console.log(`\n🚀 Stealth Transfer (${chain.toUpperCase()})`);
    console.log(`   ${'='.repeat(40)}`);

    if (chain === 'solana') {
      const sourceKeypair = parseSolanaPrivateKey(opts.key);
      console.log(`   Source:      ${sourceKeypair.publicKey.toBase58()}`);
      console.log(`   Destination: ${opts.destination}`);
      console.log(`   Amount:      ${amount} ${currencySymbol}`);
      console.log(`   Hops:        ${hopCount} (${Math.ceil(hopCount / batchSize)} batches of ${batchSize})`);
      console.log(`   RPC:         ${rpcUrl}`);
      console.log(`   Delay:       ${delayMs > 0 ? `${delayMs}ms (with random jitter)` : 'none'}`);
      console.log(`   ${'='.repeat(40)}\n`);

      await executeStealthTransfer({
        sourceKeypair,
        destinationAddress: opts.destination,
        hopCount,
        amount,
        rpcUrl,
        delayMs,
        batchSize,
      });
    } else {
      const sourceKey = parseEvmPrivateKey(opts.key);
      console.log(`   Source:      ${sourceKey.slice(0, 12)}…`);
      console.log(`   Destination: ${opts.destination}`);
      console.log(`   Amount:      ${amount} ${currencySymbol}`);
      console.log(`   Hops:        ${hopCount} (${Math.ceil(hopCount / batchSize)} batches of ${batchSize})`);
      console.log(`   RPC:         ${rpcUrl}`);
      console.log(`   Delay:       ${delayMs > 0 ? `${delayMs}ms (with random jitter)` : 'none'}`);
      console.log(`   ${'='.repeat(40)}\n`);

      await executeEvmStealthTransfer({
        sourcePrivateKey: sourceKey,
        destinationAddress: opts.destination,
        chainId: chain as EvmChainId,
        hopCount,
        amount,
        rpcUrl,
        delayMs,
        batchSize,
      });
    }

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
