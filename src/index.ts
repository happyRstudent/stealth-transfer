#!/usr/bin/env node

import { Keypair } from '@solana/web3.js';
import { Command } from 'commander';
import bs58 from 'bs58';
import { executeStealthTransfer } from './transfer.js';
import { PUBLIC_RPCS } from './rpc.js';

function parsePrivateKey(input: string): Keypair {
  // Try base58 first
  try {
    const decoded = bs58.decode(input);
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(decoded);
    }
    if (decoded.length === 32) {
      return Keypair.fromSeed(decoded);
    }
  } catch {
    // Not base58, try JSON array
  }

  // Try JSON array format [12, 34, 56, ...]
  try {
    const arr = JSON.parse(input);
    if (Array.isArray(arr) && arr.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {
    // Not JSON either
  }

  throw new Error(
    'Invalid private key format. Provide:\n' +
    '  - Base58-encoded secret key (64 bytes)\n' +
    '  - JSON array from Solana CLI (e.g., [1,2,3,...])',
  );
}

function parseAmount(value: string): number {
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) {
    throw new Error('Amount must be a positive number');
  }
  return n;
}

function parseIntOption(value: string, name: string, min: number, max: number): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

async function main() {
  const program = new Command();

  program
    .name('solana-stealth-transfer')
    .description('Route SOL through multiple intermediate wallets for privacy')
    .version('1.0.0')
    .requiredOption('-k, --key <private-key>', 'Source wallet private key (base58 or JSON array)')
    .requiredOption('-d, --destination <address>', 'Destination wallet address')
    .option('-n, --hops <number>', 'Number of intermediate wallets (2-100)', '10')
    .option('-a, --amount <sol>', 'Amount of SOL to transfer', '0.1')
    .option('-r, --rpc <url>', 'Solana RPC URL', 'https://api.mainnet.solana.com')
    .option('--delay <ms>', 'Delay between batches in ms (0 = no delay)', '500')
    .option('--batch-size <number>', 'Hops per atomic transaction (1-8)', '5');

  program.parse(process.argv);
  const opts = program.opts();

  try {
    const sourceKeypair = parsePrivateKey(opts.key);
    const destinationAddress = opts.destination;
    const hopCount = parseIntOption(opts.hops, 'Hops', 2, 100);
    const amount = parseAmount(opts.amount);
    const rpcUrl = opts.rpc;
    const delayMs = parseInt(opts.delay, 10);
    const batchSize = parseIntOption(opts.batchSize, 'Batch size', 1, 8);

    // Validate destination address format
    if (destinationAddress.length < 32 || destinationAddress.length > 44) {
      throw new Error('Invalid destination address');
    }

    console.log(`\n🚀 Solana Stealth Transfer`);
    console.log(`   ${'='.repeat(40)}`);
    console.log(`   Source:      ${sourceKeypair.publicKey.toBase58()}`);
    console.log(`   Destination: ${destinationAddress}`);
    console.log(`   Amount:      ${amount} SOL`);
    console.log(`   Hops:        ${hopCount} (${Math.ceil(hopCount / batchSize)} batches of ${batchSize})`);
    console.log(`   RPC:         ${rpcUrl}`);
    console.log(`   Delay:       ${delayMs > 0 ? `${delayMs}ms (with random jitter)` : 'none'}`);
    console.log(`   ${'='.repeat(40)}\n`);

    await executeStealthTransfer({
      sourceKeypair,
      destinationAddress,
      hopCount,
      amount,
      rpcUrl,
      delayMs,
      batchSize,
    });

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
