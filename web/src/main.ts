import './style.css';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createRecoverableRoute,
  decryptRecoveryBundle as solDecryptBundle,
  encryptRecoveryBundle as solEncryptBundle,
  estimateTransferFee as solEstimateFee,
  executeStealthTransfer as solExecute,
  hydrateIntermediateKeypairs,
  recoverIntermediateBalances as solRecover,
} from '../../src/chains/solana/transfer.ts';
import type { ProgressEvent, RecoverableRoute, RecoveryBundle } from '../../src/chains/solana/transfer.ts';
import {
  createEvmRecoverableRoute,
  decryptRecoveryBundle as evmDecryptBundle,
  encryptRecoveryBundle as evmEncryptBundle,
  executeEvmStealthTransfer as evmExecute,
  hydrateIntermediatePrivateKeys,
  recoverIntermediateBalances as evmRecover,
  addressFromPrivateKey,
} from '../../src/chains/evm/transfer.ts';
import { EVM_PUBLIC_RPCS, EVM_EXPLORERS, testEvmRpcLatency } from '../../src/chains/evm/rpc.ts';
import type { EvmChainId, EvmRecoverableRoute } from '../../src/chains/evm/types.ts';
import type { ChainId } from '../../src/shared/types.ts';

// ═══════════════════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════════════════

let activeChain: ChainId = 'solana';
let isRunning = false;
let isSolKeyVisible = false;
let isEvmKeyVisible = false;

const RECOVERY_STORAGE_KEY = 'stealth-transfer:recovery-bundle';

// ═══════════════════════════════════════════════════════════════════════════
//  DOM helpers
// ═══════════════════════════════════════════════════════════════════════════

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Shared
const logEntries = $<HTMLDivElement>('logEntries');
const logEmpty = $<HTMLDivElement>('logEmpty');
const recoveryInput = $<HTMLTextAreaElement>('recoveryInput');
const restorePassword = $<HTMLInputElement>('restorePassword');
const continueRecovery = $<HTMLButtonElement>('continueRecovery');
const sweepRecovery = $<HTMLButtonElement>('sweepRecovery');
const refundRecovery = $<HTMLButtonElement>('refundRecovery');
const exportKeys = $<HTMLButtonElement>('exportKeys');
const chainTabs = $<HTMLDivElement>('chainTabs');

// Solana panel
const solanaPanel = $<HTMLElement>('solanaPanel');
const solPrivKey = $<HTMLTextAreaElement>('solPrivKey');
const solToggleKey = $<HTMLButtonElement>('solToggleKey');
const solDestAddr = $<HTMLInputElement>('solDestAddr');
const solAddrHint = $<HTMLSpanElement>('solAddrHint');
const solHopCount = $<HTMLInputElement>('solHopCount');
const solHopCountNum = $<HTMLInputElement>('solHopCountNum');
const solHopCountVal = $<HTMLSpanElement>('solHopCountVal');
const solAmount = $<HTMLInputElement>('solAmount');
const solRpcUrl = $<HTMLSelectElement>('solRpcUrl');
const solRpcCustom = $<HTMLInputElement>('solRpcCustom');
const solTestRpc = $<HTMLButtonElement>('solTestRpc');
const solRpcDot = $<HTMLSpanElement>('solRpcDot');
const solDelayMs = $<HTMLInputElement>('solDelayMs');
const solDelayMsNum = $<HTMLInputElement>('solDelayMsNum');
const solDelayMsVal = $<HTMLSpanElement>('solDelayMsVal');
const solBatchSize = $<HTMLInputElement>('solBatchSize');
const solBatchSizeNum = $<HTMLInputElement>('solBatchSizeNum');
const solBatchSizeVal = $<HTMLSpanElement>('solBatchSizeVal');
const solRecoveryPassword = $<HTMLInputElement>('solRecoveryPassword');
const solNoRecovery = $<HTMLInputElement>('solNoRecovery');
const solExecuteBtn = $<HTMLButtonElement>('solExecuteBtn');
const solFeeValue = $<HTMLSpanElement>('solFeeValue');

// EVM panel
const evmPanel = $<HTMLElement>('evmPanel');
const evmPanelTitle = $<HTMLElement>('evmPanelTitle');
const evmPrivKey = $<HTMLTextAreaElement>('evmPrivKey');
const evmToggleKey = $<HTMLButtonElement>('evmToggleKey');
const evmDestAddr = $<HTMLInputElement>('evmDestAddr');
const evmAddrHint = $<HTMLSpanElement>('evmAddrHint');
const evmHopCount = $<HTMLInputElement>('evmHopCount');
const evmHopCountNum = $<HTMLInputElement>('evmHopCountNum');
const evmHopCountVal = $<HTMLSpanElement>('evmHopCountVal');
const evmAmount = $<HTMLInputElement>('evmAmount');
const evmAmountHint = $<HTMLSpanElement>('evmAmountHint');
const evmRpcUrl = $<HTMLSelectElement>('evmRpcUrl');
const evmRpcCustom = $<HTMLInputElement>('evmRpcCustom');
const evmTestRpc = $<HTMLButtonElement>('evmTestRpc');
const evmRpcDot = $<HTMLSpanElement>('evmRpcDot');
const evmDelayMs = $<HTMLInputElement>('evmDelayMs');
const evmDelayMsNum = $<HTMLInputElement>('evmDelayMsNum');
const evmDelayMsVal = $<HTMLSpanElement>('evmDelayMsVal');
const evmBatchSize = $<HTMLInputElement>('evmBatchSize');
const evmBatchSizeNum = $<HTMLInputElement>('evmBatchSizeNum');
const evmBatchSizeVal = $<HTMLSpanElement>('evmBatchSizeVal');
const evmRecoveryPassword = $<HTMLInputElement>('evmRecoveryPassword');
const evmNoRecovery = $<HTMLInputElement>('evmNoRecovery');
const evmExecuteBtn = $<HTMLButtonElement>('evmExecuteBtn');
const evmFeeValue = $<HTMLSpanElement>('evmFeeValue');

// ═══════════════════════════════════════════════════════════════════════════
//  Utils
// ═══════════════════════════════════════════════════════════════════════════

function parseSolanaPrivateKey(input: string): Keypair {
  try {
    const decoded = bs58.decode(input.trim());
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
  } catch { /* try JSON */ }
  try {
    const arr = JSON.parse(input.trim());
    if (Array.isArray(arr) && arr.length === 64)
      return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* not JSON */ }
  throw new Error('Invalid Solana private key. Use base58 (64 bytes) or JSON array format.');
}

function parseEvmPrivateKey(input: string): string {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return '0x' + trimmed;
  throw new Error('Invalid EVM private key. Provide a 64-character hex string (with or without 0x prefix).');
}

type DetectedFormat = 'solana' | 'evm' | 'unknown';

function detectAddressFormat(address: string): DetectedFormat {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  return 'unknown';
}

function getCurrentEvmChain(): EvmChainId {
  return activeChain as EvmChainId;
}

function getChainCurrencySymbol(): string {
  switch (activeChain) {
    case 'solana': return 'SOL';
    case 'eth': return 'ETH';
    case 'bsc': return 'BNB';
    case 'base': return 'ETH';
    default: return '';
  }
}

function clampInt(value: string, min: number, max: number): string {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return String(min);
  return String(Math.min(max, Math.max(min, parsed)));
}

function bindRangeAndNumber({
  range, number, label, onChange,
}: {
  range: HTMLInputElement;
  number: HTMLInputElement;
  label: HTMLSpanElement;
  format?: (value: string) => string;
  onChange?: () => void;
}) {
  const sync = (value: string) => {
    const next = clampInt(value, Number(range.min), Number(range.max));
    range.value = next;
    number.value = next;
    label.textContent = next;
    onChange?.();
  };
  range.addEventListener('input', () => sync(range.value));
  number.addEventListener('input', () => sync(number.value));
  sync(range.value);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Log
// ═══════════════════════════════════════════════════════════════════════════

function log(type: ProgressEvent['type'], msg: string, link?: string) {
  logEmpty.style.display = 'none';
  logEntries.classList.add('active');
  const el = document.createElement('div');
  el.className = `log-entry log-entry--${type}`;
  const ts = new Date().toLocaleTimeString();
  el.textContent = `[${ts}] ${msg}`;
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = ' ↗';
    el.appendChild(anchor);
  }
  logEntries.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
}

function saveRecoveryBundle(bundle: RecoveryBundle | any) {
  const serialized = JSON.stringify(bundle, null, 2);
  localStorage.setItem(RECOVERY_STORAGE_KEY, serialized);
  recoveryInput.value = serialized;
}

function downloadRecoveryBundle(bundle: RecoveryBundle | any) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `stealth-transfer-recovery-${activeChain}-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chain switching
// ═══════════════════════════════════════════════════════════════════════════

function switchChain(chain: ChainId) {
  activeChain = chain;

  // Update tabs
  chainTabs.querySelectorAll('.chain-tab').forEach((tab) => {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.chain === chain);
  });

  // Toggle panels
  solanaPanel.style.display = chain === 'solana' ? '' : 'none';
  evmPanel.style.display = chain !== 'solana' ? '' : 'none';

  // Update EVM panel title
  const chainName = { eth: 'Ethereum', bsc: 'BNB Smart Chain', base: 'Base' }[chain] || 'EVM';
  evmPanelTitle.textContent = `${chainName} Transfer Configuration`;

  // Update currency hints
  const sym = getChainCurrencySymbol();
  evmAmountHint.textContent = sym;

  // Rebuild EVM RPC dropdown
  if (chain !== 'solana') {
    buildEvmRpcDropdown(chain as EvmChainId);
  }

  updateFeeEstimate();
}

function buildEvmRpcDropdown(chainId: EvmChainId) {
  const rpcs = EVM_PUBLIC_RPCS[chainId] || [];
  evmRpcUrl.innerHTML = rpcs.map((url) => {
    const label = new URL(url).hostname;
    return `<option value="${url}">${label}</option>`;
  }).join('') + '<option value="custom">Custom private/paid RPC…</option>';
  evmRpcCustom.classList.remove('visible');
}

// ─── Address detection on input ──────────────────────────────────────────

function setupAddressDetection(
  inputEl: HTMLInputElement,
  hintEl: HTMLSpanElement,
  getChain: () => ChainId,
) {
  inputEl.addEventListener('input', () => {
    const addr = inputEl.value.trim();
    if (!addr) { hintEl.textContent = ''; hintEl.className = 'field-hint'; return; }

    const currentChain = getChain();
    const detected = detectAddressFormat(addr);
    if (detected === 'unknown') {
      hintEl.textContent = '⚠ Unrecognized address format';
      hintEl.className = 'field-hint field-hint--warn';
      return;
    }

    const expected = currentChain === 'solana' ? 'solana' : 'evm';
    if (detected !== expected) {
      hintEl.innerHTML = `⚠ This looks like a <b>${detected.toUpperCase()}</b> address, but you are on <b>${currentChain.toUpperCase()}</b>. <a href="#" class="switch-link" data-chain="${detected === 'solana' ? 'solana' : 'eth'}">Switch chain →</a>`;
      hintEl.className = 'field-hint field-hint--warn';
      // Attach click handler to switch link
      const link = hintEl.querySelector('.switch-link');
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const targetChain = (link as HTMLElement).dataset.chain as ChainId;
          switchChain(targetChain);
        });
      }
    } else {
      hintEl.textContent = detected === 'evm' ? '✓ Valid EVM address' : '✓ Valid Solana address';
      hintEl.className = 'field-hint';
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Fee estimation
// ═══════════════════════════════════════════════════════════════════════════

function updateFeeEstimate() {
  if (activeChain === 'solana') {
    const hops = parseInt(solHopCount.value) || 10;
    const bs = parseInt(solBatchSize.value) || 5;
    const estimate = solEstimateFee({ hopCount: hops, batchSize: bs });
    solFeeValue.textContent = `~${estimate.feeSol.toFixed(9)} SOL (${estimate.signatureCount} signatures)`;
  } else {
    const hops = parseInt(evmHopCount.value) || 10;
    const bs = parseInt(evmBatchSize.value) || 5;
    const totalHops = hops + 1;
    const batchCount = Math.ceil(totalHops / bs);
    evmFeeValue.textContent = `${totalHops} txs in ${batchCount} batch(es) — gas estimated at execution`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Solana execution
// ═══════════════════════════════════════════════════════════════════════════

function getSolRpcUrl(): string {
  const selected = solRpcUrl.value;
  if (selected === 'custom') {
    const custom = solRpcCustom.value.trim();
    if (!custom) throw new Error('Enter a custom RPC URL.');
    return custom;
  }
  return selected;
}

solToggleKey.addEventListener('click', () => {
  isSolKeyVisible = !isSolKeyVisible;
  solPrivKey.classList.toggle('input--secret', !isSolKeyVisible);
  solToggleKey.textContent = isSolKeyVisible ? '🙈' : '👁️';
});
solPrivKey.classList.add('input--secret');

bindRangeAndNumber({ range: solHopCount, number: solHopCountNum, label: solHopCountVal, onChange: updateFeeEstimate });
bindRangeAndNumber({ range: solDelayMs, number: solDelayMsNum, label: solDelayMsVal });
bindRangeAndNumber({ range: solBatchSize, number: solBatchSizeNum, label: solBatchSizeVal, onChange: updateFeeEstimate });
solAmount.addEventListener('input', updateFeeEstimate);

solRpcUrl.addEventListener('change', () => {
  solRpcCustom.classList.toggle('visible', solRpcUrl.value === 'custom');
  solRpcDot.className = 'dot dot--idle';
});
solRpcCustom.classList.toggle('visible', solRpcUrl.value === 'custom');

solTestRpc.addEventListener('click', async () => {
  try {
    const url = getSolRpcUrl();
    solRpcDot.className = 'dot dot--loading';
    const start = performance.now();
    const conn = new Connection(url, { commitment: 'confirmed' });
    await conn.getSlot();
    const ms = (performance.now() - start).toFixed(0);
    solRpcDot.className = 'dot dot--ok';
    log('success', `Solana RPC latency: ${ms}ms (${url})`);
  } catch {
    solRpcDot.className = 'dot dot--fail';
    log('error', 'RPC unreachable — try another endpoint.');
  }
});

setupAddressDetection(solDestAddr, solAddrHint, () => 'solana');

solExecuteBtn.addEventListener('click', async () => {
  if (isRunning) return;
  const keyRaw = solPrivKey.value.trim();
  const destRaw = solDestAddr.value.trim();
  const amt = parseFloat(solAmount.value);
  const hops = parseInt(solHopCount.value);
  const bs = parseInt(solBatchSize.value);
  const dl = parseInt(solDelayMs.value);

  if (!keyRaw) { log('error', 'Enter the source private key.'); return; }
  if (!destRaw || destRaw.length < 32) { log('error', 'Enter a valid destination address.'); return; }
  if (!amt || amt <= 0) { log('error', 'Enter a valid amount.'); return; }
  if (!hops || hops < 2 || hops > 100) { log('error', 'Hops must be 2–100.'); return; }
  if (!bs || bs < 1 || bs > 8) { log('error', 'Batch size must be 1–8.'); return; }

  let sourceKeypair: Keypair;
  try {
    sourceKeypair = parseSolanaPrivateKey(keyRaw);
    log('info', `Source: ${sourceKeypair.publicKey.toBase58().slice(0, 12)}…`);
  } catch (e) {
    log('error', `Key error: ${(e as Error).message}`);
    return;
  }

  let rpcUrlFinal: string;
  try { rpcUrlFinal = getSolRpcUrl(); } catch (e) {
    log('error', (e as Error).message); return;
  }

  log('info', `Destination: ${destRaw.slice(0, 12)}…`);
  log('info', `Route: ${sourceKeypair.publicKey.toBase58().slice(0, 8)}… → ${hops} hops → ${destRaw.slice(0, 8)}…`);

  let route: RecoverableRoute;
  const transactions: string[] = [];

  try {
    new PublicKey(destRaw);
    route = createRecoverableRoute({
      sourcePublicKey: sourceKeypair.publicKey,
      destinationAddress: destRaw,
      hopCount: hops,
    });

    if (!solNoRecovery.checked) {
      const password = solRecoveryPassword.value;
      if (!password) { log('error', 'Set a recovery password or check "run without recovery".'); return; }
      const bundle = await solEncryptBundle({
        password, route, amount: amt, batchSize: bs, rpcUrl: rpcUrlFinal,
      });
      saveRecoveryBundle(bundle);
      downloadRecoveryBundle(bundle);
      log('success', 'Encrypted recovery bundle created and saved locally.');
    }
  } catch (e) {
    log('error', `Recovery setup error: ${(e as Error).message}`);
    return;
  }

  isRunning = true;
  solExecuteBtn.disabled = true;
  solExecuteBtn.classList.add('btn--loading');
  solExecuteBtn.querySelector('.btn-icon')!.textContent = '⏳';

  try {
    await solExecute({
      sourceKeypair, destinationAddress: destRaw, hopCount: hops,
      amount: amt, rpcUrl: rpcUrlFinal, delayMs: dl, batchSize: bs,
      intermediateKeypairs: route.intermediateKeypairs,
      onBatchConfirmed: async (progress) => {
        transactions.push(progress.txHash);
        if (!solNoRecovery.checked) {
          const bundle = await solEncryptBundle({
            password: solRecoveryPassword.value, route, amount: amt,
            batchSize: bs, rpcUrl: rpcUrlFinal,
            lastCompletedBatch: progress.lastCompletedBatch, transactions,
          });
          saveRecoveryBundle(bundle);
        }
      },
    }, (ev) => {
      if (ev.type === 'success') log(ev.type, ev.message, ev.data?.txUrl as string | undefined);
      else log(ev.type, ev.message);
    });
    log('success', 'Transfer complete. All SOL forwarded cleanly.');
  } catch (e) {
    log('error', `${(e as Error).message}`);
  } finally {
    isRunning = false;
    solExecuteBtn.disabled = false;
    solExecuteBtn.classList.remove('btn--loading');
    solExecuteBtn.querySelector('.btn-icon')!.textContent = '🚀';
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EVM execution
// ═══════════════════════════════════════════════════════════════════════════

function getEvmRpcUrl(): string {
  const selected = evmRpcUrl.value;
  if (selected === 'custom') {
    const custom = evmRpcCustom.value.trim();
    if (!custom) throw new Error('Enter a custom RPC URL.');
    return custom;
  }
  return selected;
}

evmToggleKey.addEventListener('click', () => {
  isEvmKeyVisible = !isEvmKeyVisible;
  evmPrivKey.classList.toggle('input--secret', !isEvmKeyVisible);
  evmToggleKey.textContent = isEvmKeyVisible ? '🙈' : '👁️';
});
evmPrivKey.classList.add('input--secret');

bindRangeAndNumber({ range: evmHopCount, number: evmHopCountNum, label: evmHopCountVal, onChange: updateFeeEstimate });
bindRangeAndNumber({ range: evmDelayMs, number: evmDelayMsNum, label: evmDelayMsVal });
bindRangeAndNumber({ range: evmBatchSize, number: evmBatchSizeNum, label: evmBatchSizeVal, onChange: updateFeeEstimate });
evmAmount.addEventListener('input', updateFeeEstimate);

evmRpcUrl.addEventListener('change', () => {
  evmRpcCustom.classList.toggle('visible', evmRpcUrl.value === 'custom');
  evmRpcDot.className = 'dot dot--idle';
});
evmRpcCustom.classList.toggle('visible', evmRpcUrl.value === 'custom');

evmTestRpc.addEventListener('click', async () => {
  try {
    const url = getEvmRpcUrl();
    const chainId = getCurrentEvmChain();
    evmRpcDot.className = 'dot dot--loading';
    const ms = await testEvmRpcLatency(chainId, url);
    if (ms >= 0) {
      evmRpcDot.className = 'dot dot--ok';
      log('success', `EVM RPC latency: ${ms}ms (${url})`);
    } else {
      evmRpcDot.className = 'dot dot--fail';
      log('error', 'RPC unreachable — try another endpoint.');
    }
  } catch {
    evmRpcDot.className = 'dot dot--fail';
    log('error', 'RPC unreachable — try another endpoint.');
  }
});

setupAddressDetection(evmDestAddr, evmAddrHint, () => activeChain);

evmExecuteBtn.addEventListener('click', async () => {
  if (isRunning) return;
  const keyRaw = evmPrivKey.value.trim();
  const destRaw = evmDestAddr.value.trim();
  const amt = parseFloat(evmAmount.value);
  const hops = parseInt(evmHopCount.value);
  const bs = parseInt(evmBatchSize.value);
  const dl = parseInt(evmDelayMs.value);

  if (!keyRaw) { log('error', 'Enter the source private key.'); return; }
  if (!destRaw || !/^0x[0-9a-fA-F]{40}$/.test(destRaw)) {
    log('error', 'Enter a valid 0x-prefixed destination address.'); return;
  }
  if (!amt || amt <= 0) { log('error', 'Enter a valid amount.'); return; }
  if (!hops || hops < 2 || hops > 100) { log('error', 'Hops must be 2–100.'); return; }
  if (!bs || bs < 1 || bs > 100) { log('error', 'Batch size must be 1–100.'); return; }

  let sourceKey: string;
  try {
    sourceKey = parseEvmPrivateKey(keyRaw);
    const addr = addressFromPrivateKey(sourceKey);
    log('info', `Source: ${addr.slice(0, 12)}…`);
  } catch (e) {
    log('error', `Key error: ${(e as Error).message}`);
    return;
  }

  let rpcUrlFinal: string;
  try { rpcUrlFinal = getEvmRpcUrl(); } catch (e) {
    log('error', (e as Error).message); return;
  }

  const chainId = getCurrentEvmChain();
  const sourceAddr = addressFromPrivateKey(sourceKey);
  log('info', `Chain: ${chainId.toUpperCase()}`);
  log('info', `Destination: ${destRaw.slice(0, 12)}…`);
  log('info', `Route: ${sourceAddr.slice(0, 8)}… → ${hops} hops → ${destRaw.slice(0, 8)}…`);

  let route: EvmRecoverableRoute;
  const transactions: string[] = [];

  try {
    route = createEvmRecoverableRoute({
      sourceAddress: sourceAddr,
      destinationAddress: destRaw,
      hopCount: hops,
    });

    if (!evmNoRecovery.checked) {
      const password = evmRecoveryPassword.value;
      if (!password) { log('error', 'Set a recovery password or check "run without recovery".'); return; }
      const bundle = await evmEncryptBundle({
        password, chainId, route, amount: amt, batchSize: bs, rpcUrl: rpcUrlFinal,
      });
      saveRecoveryBundle(bundle);
      downloadRecoveryBundle(bundle);
      log('success', 'Encrypted recovery bundle created and saved locally.');
    }
  } catch (e) {
    log('error', `Recovery setup error: ${(e as Error).message}`);
    return;
  }

  isRunning = true;
  evmExecuteBtn.disabled = true;
  evmExecuteBtn.classList.add('btn--loading');
  evmExecuteBtn.querySelector('.btn-icon')!.textContent = '⏳';

  try {
    await evmExecute({
      sourcePrivateKey: sourceKey,
      destinationAddress: destRaw,
      chainId,
      hopCount: hops,
      amount: amt,
      rpcUrl: rpcUrlFinal,
      delayMs: dl,
      batchSize: bs,
      intermediatePrivateKeys: route.intermediatePrivateKeys,
      onHopConfirmed: async (progress) => {
        transactions.push(progress.txHash);
        if (!evmNoRecovery.checked) {
          const bundle = await evmEncryptBundle({
            password: evmRecoveryPassword.value, chainId, route, amount: amt,
            batchSize: bs, rpcUrl: rpcUrlFinal,
            lastCompletedBatch: progress.lastCompletedBatch, transactions,
          });
          saveRecoveryBundle(bundle);
        }
      },
    }, (ev) => {
      if (ev.type === 'success') log(ev.type, ev.message, ev.data?.txUrl as string | undefined);
      else log(ev.type, ev.message);
    });
    log('success', `Transfer complete. All ${getChainCurrencySymbol()} forwarded cleanly.`);
  } catch (e) {
    log('error', `${(e as Error).message}`);
  } finally {
    isRunning = false;
    evmExecuteBtn.disabled = false;
    evmExecuteBtn.classList.remove('btn--loading');
    evmExecuteBtn.querySelector('.btn-icon')!.textContent = '🚀';
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Recovery (shared — auto-detect chain from bundle)
// ═══════════════════════════════════════════════════════════════════════════

function readRecoveryBundle(): any {
  const raw = recoveryInput.value.trim() || localStorage.getItem(RECOVERY_STORAGE_KEY);
  if (!raw) throw new Error('Paste a recovery bundle or create one by executing a transfer.');
  return JSON.parse(raw);
}

async function runRecovery(action: 'continue' | 'sweep' | 'refund') {
  if (isRunning) return;
  isRunning = true;
  try {
    const bundle = readRecoveryBundle();
    const password = restorePassword.value;
    if (!password) throw new Error('Enter the recovery password.');

    const chain = bundle.chain || 'solana';

    if (chain === 'solana') {
      const restored = await solDecryptBundle(bundle, password);
      const intermediates = hydrateIntermediateKeypairs(restored);

      if (action === 'continue') {
        const keyRaw = solPrivKey.value.trim();
        if (!keyRaw) throw new Error('Enter the source private key to continue.');
        const sourceKeypair = parseSolanaPrivateKey(keyRaw);
        if (sourceKeypair.publicKey.toBase58() !== restored.sourceAddress) {
          throw new Error('Source private key does not match recovery bundle.');
        }
        const startBatch = restored.lastCompletedBatch + 1;
        const estimate = solEstimateFee({ hopCount: restored.hopCount, batchSize: restored.batchSize });
        if (startBatch >= estimate.batchCount) {
          log('success', 'All batches already complete.'); return;
        }
        log('info', `Continuing from batch ${startBatch + 1}/${estimate.batchCount}.`);
        await solExecute({
          sourceKeypair, destinationAddress: restored.destinationAddress,
          hopCount: restored.hopCount, amount: restored.amount,
          rpcUrl: restored.rpcUrl, delayMs: 500,
          batchSize: restored.batchSize, intermediateKeypairs: intermediates,
          startBatch,
          onBatchConfirmed: async (progress) => {
            const route: RecoverableRoute = {
              sourcePublicKey: restored.sourceAddress,
              destinationAddress: restored.destinationAddress,
              hopCount: restored.hopCount,
              intermediateKeypairs: intermediates,
              routePublicKeys: restored.routeAddresses,
            };
            const b = await solEncryptBundle({
              password, route, amount: restored.amount,
              batchSize: restored.batchSize, rpcUrl: restored.rpcUrl,
              lastCompletedBatch: progress.lastCompletedBatch,
              transactions: [...restored.transactions, progress.txHash],
            });
            saveRecoveryBundle(b);
          },
        }, (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined));
        log('success', 'Continuation complete.');
      } else {
        // sweep or refund
        const targetAddress = action === 'sweep' ? restored.destinationAddress : restored.sourceAddress;
        await solRecover({
          rpcUrl: restored.rpcUrl, intermediateKeypairs: intermediates,
          targetAddress,
          onProgress: (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined),
        });
        log('success', action === 'sweep' ? 'Sweep complete.' : 'Refund complete.');
      }
    } else {
      // EVM chain recovery
      const restored = await evmDecryptBundle(bundle, password);
      const intermediates = hydrateIntermediatePrivateKeys(restored);
      const evmChain = (restored.chain || 'eth') as EvmChainId;

      if (action === 'continue') {
        const keyRaw = evmPrivKey.value.trim();
        if (!keyRaw) throw new Error('Enter the source private key to continue.');
        const sourceKey = parseEvmPrivateKey(keyRaw);
        if (addressFromPrivateKey(sourceKey).toLowerCase() !== restored.sourceAddress.toLowerCase()) {
          throw new Error('Source private key does not match recovery bundle.');
        }
        const startHop = restored.lastCompletedBatch + 1;
        const totalHops = restored.hopCount + 1;
        if (startHop >= totalHops) {
          log('success', 'All hops already complete.'); return;
        }
        log('info', `Continuing from hop ${startHop + 1}/${totalHops}.`);
        await evmExecute({
          sourcePrivateKey: sourceKey, destinationAddress: restored.destinationAddress,
          chainId: evmChain, hopCount: restored.hopCount, amount: restored.amount,
          rpcUrl: restored.rpcUrl, delayMs: 500,
          batchSize: restored.batchSize, intermediatePrivateKeys: intermediates,
          startHop,
          onHopConfirmed: async (progress) => {
            const route: EvmRecoverableRoute = {
              sourceAddress: restored.sourceAddress,
              destinationAddress: restored.destinationAddress,
              hopCount: restored.hopCount,
              intermediatePrivateKeys: intermediates,
              routeAddresses: restored.routeAddresses,
            };
            const b = await evmEncryptBundle({
              password, chainId: evmChain, route, amount: restored.amount,
              batchSize: restored.batchSize, rpcUrl: restored.rpcUrl,
              lastCompletedBatch: progress.lastCompletedBatch,
              transactions: [...restored.transactions, progress.txHash],
            });
            saveRecoveryBundle(b);
          },
        }, (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined));
        log('success', 'Continuation complete.');
      } else {
        const targetAddress = action === 'sweep' ? restored.destinationAddress : restored.sourceAddress;
        await evmRecover({
          chainId: evmChain, rpcUrl: restored.rpcUrl,
          intermediatePrivateKeys: intermediates,
          targetAddress,
          onProgress: (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined),
        });
        log('success', action === 'sweep' ? 'Sweep complete.' : 'Refund complete.');
      }
    }
  } catch (e) {
    log('error', `Recovery error: ${(e as Error).message}`);
  } finally {
    isRunning = false;
  }
}

// ─── Export intermediate private keys ────────────────────────────────────

exportKeys.addEventListener('click', async () => {
  try {
    const bundle = readRecoveryBundle();
    const password = restorePassword.value;
    if (!password) throw new Error('Enter the recovery password.');

    const chain = bundle.chain || 'solana';
    let keys: string[];

    if (chain === 'solana') {
      const restored = await solDecryptBundle(bundle, password);
      const intermediates = hydrateIntermediateKeypairs(restored);
      keys = intermediates.map((kp) => bs58.encode(kp.secretKey));
    } else {
      const restored = await evmDecryptBundle(bundle, password);
      keys = hydrateIntermediatePrivateKeys(restored);
    }

    log('info', `=== ${keys.length} Intermediate Wallet Private Keys ===`);
    keys.forEach((key, i) => {
      log('warn', `Wallet ${i + 1}: ${key}`);
    });
    log('info', '=== Save these keys securely. Anyone with them controls the funds. ===');
  } catch (e) {
    log('error', `Export error: ${(e as Error).message}`);
  }
});

continueRecovery.addEventListener('click', () => void runRecovery('continue'));
sweepRecovery.addEventListener('click', () => void runRecovery('sweep'));
refundRecovery.addEventListener('click', () => void runRecovery('refund'));

// ═══════════════════════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════════════════════

// Chain tab click handlers
chainTabs.querySelectorAll('.chain-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const chain = (tab as HTMLElement).dataset.chain as ChainId;
    switchChain(chain);
  });
});

// Load saved recovery bundle
const savedRecovery = localStorage.getItem(RECOVERY_STORAGE_KEY);
if (savedRecovery) {
  recoveryInput.value = savedRecovery;
  try {
    const parsed = JSON.parse(savedRecovery);
    if (parsed.chain) {
      log('warn', `Saved recovery bundle detected (${parsed.chain.toUpperCase()}).`);
    } else {
      log('warn', 'Saved recovery bundle detected (Solana, legacy).');
    }
  } catch { /* ignore */ }
}

// Initialize Solana
switchChain('solana');
updateFeeEstimate();
log('info', 'Ready. Select a chain, configure your transfer, and press Execute.');
