import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateEvmPrivateKeys,
  addressFromPrivateKey,
  generateIntermediateWallets,
  getBatchRange,
  createEvmRecoverableRoute,
  encryptRecoveryBundle,
  decryptRecoveryBundle,
  hydrateIntermediatePrivateKeys,
} from '../src/chains/evm/transfer.js';

describe('EVM wallet generation', () => {
  it('generates the requested number of private keys', () => {
    const keys = generateEvmPrivateKeys(10);
    assert.equal(keys.length, 10);
    for (const key of keys) {
      assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key), `Invalid key format: ${key.slice(0, 10)}…`);
    }
  });

  it('generates unique keys', () => {
    const keys = generateEvmPrivateKeys(20);
    const unique = new Set(keys.map((k) => k.toLowerCase()));
    assert.equal(unique.size, 20);
  });

  it('derives valid addresses from private keys', () => {
    const key = '0x' + 'a'.repeat(64);
    const addr = addressFromPrivateKey(key);
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(addr));
  });

  it('generateIntermediateWallets returns matching arrays', () => {
    const { privateKeys, addresses } = generateIntermediateWallets(5);
    assert.equal(privateKeys.length, 5);
    assert.equal(addresses.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(addressFromPrivateKey(privateKeys[i]), addresses[i]);
    }
  });
});

describe('getBatchRange (EVM)', () => {
  it('splits hops into batches', () => {
    // hopCount=10 → totalHops=11, batchSize=5 → 3 batches
    assert.deepEqual(getBatchRange({ batchIndex: 0, hopCount: 10, batchSize: 5 }), {
      hopStart: 0, hopEnd: 5,
    });
    assert.deepEqual(getBatchRange({ batchIndex: 1, hopCount: 10, batchSize: 5 }), {
      hopStart: 5, hopEnd: 10,
    });
    assert.deepEqual(getBatchRange({ batchIndex: 2, hopCount: 10, batchSize: 5 }), {
      hopStart: 10, hopEnd: 11,
    });
  });
});

describe('EVM recoverable route + recovery bundle', () => {
  it('encrypts and decrypts a recovery bundle correctly', async () => {
    const route = createEvmRecoverableRoute({
      sourceAddress: '0x' + 'a'.repeat(40),
      destinationAddress: '0x' + 'b'.repeat(40),
      hopCount: 4,
    });

    const bundle = await encryptRecoveryBundle({
      password: 'correct horse battery staple',
      chainId: 'eth',
      route,
      amount: 0.01,
      batchSize: 3,
      rpcUrl: 'https://eth.llamarpc.com',
    });

    assert.equal(bundle.version, 1);
    assert.equal(bundle.chain, 'eth');
    assert.ok(bundle.ciphertext.length > 0);
    assert.ok(bundle.salt.length > 0);
    assert.ok(bundle.iv.length > 0);

    const restored = await decryptRecoveryBundle(bundle, 'correct horse battery staple');
    assert.equal(restored.chain, 'eth');
    assert.equal(restored.sourceAddress.toLowerCase(), '0x' + 'a'.repeat(40));
    assert.equal(restored.destinationAddress.toLowerCase(), '0x' + 'b'.repeat(40));
    assert.equal(restored.hopCount, 4);
    assert.equal(restored.amount, 0.01);
    assert.equal(restored.batchSize, 3);
    assert.equal(restored.routeAddresses.length, 6); // source + 4 intermediates + dest
  });

  it('hydrates intermediate private keys from decrypted bundle', async () => {
    const route = createEvmRecoverableRoute({
      sourceAddress: '0x' + 'c'.repeat(40),
      destinationAddress: '0x' + 'd'.repeat(40),
      hopCount: 3,
    });

    const bundle = await encryptRecoveryBundle({
      password: 'test password 123',
      chainId: 'bsc',
      route,
      amount: 0.5,
      batchSize: 2,
      rpcUrl: 'https://bsc-dataseed.binance.org',
    });

    const restored = await decryptRecoveryBundle(bundle, 'test password 123');
    const hydrated = hydrateIntermediatePrivateKeys(restored);

    assert.equal(hydrated.length, 3);
    for (const key of hydrated) {
      assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key));
    }
    // Hydrated private keys should derive the same addresses as the original route
    const hydratedAddrs = hydrated.map(addressFromPrivateKey);
    const originalAddrs = route.intermediatePrivateKeys.map(addressFromPrivateKey);
    assert.deepEqual(
      hydratedAddrs.map((a) => a.toLowerCase()),
      originalAddrs.map((a) => a.toLowerCase()),
    );
  });

  it('rejects decryption with wrong password', async () => {
    const route = createEvmRecoverableRoute({
      sourceAddress: '0x' + 'e'.repeat(40),
      destinationAddress: '0x' + 'f'.repeat(40),
      hopCount: 2,
    });

    const bundle = await encryptRecoveryBundle({
      password: 'correct1',
      chainId: 'base',
      route,
      amount: 0.1,
      batchSize: 2,
      rpcUrl: 'https://mainnet.base.org',
    });

    await assert.rejects(
      () => decryptRecoveryBundle(bundle, 'wrong password'),
      /operation failed/i,
    );
  });
});
