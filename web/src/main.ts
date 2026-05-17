import './style.css';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createRecoverableRoute,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  estimateTransferFee,
  executeStealthTransfer,
  hydrateIntermediateKeypairs,
  recoverIntermediateBalances,
} from '../../src/transfer.ts';
import type { ProgressEvent, RecoverableRoute, RecoveryBundle } from '../../src/transfer.ts';

// ═══════════════════════════════════════════════════════════════════════════
//  DOM refs
// ═══════════════════════════════════════════════════════════════════════════

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const privKey = $<HTMLTextAreaElement>('privKey');
const toggleKey = $<HTMLButtonElement>('toggleKey');
const destAddr = $<HTMLInputElement>('destAddr');
const hopCount = $<HTMLInputElement>('hopCount');
const hopCountNum = $<HTMLInputElement>('hopCountNum');
const hopCountVal = $<HTMLSpanElement>('hopCountVal');
const amount = $<HTMLInputElement>('amount');
const rpcUrl = $<HTMLSelectElement>('rpcUrl');
const rpcCustom = $<HTMLInputElement>('rpcCustom');
const testRpc = $<HTMLButtonElement>('testRpc');
const rpcDot = $<HTMLSpanElement>('rpcDot');
const delayMs = $<HTMLInputElement>('delayMs');
const delayMsNum = $<HTMLInputElement>('delayMsNum');
const delayMsVal = $<HTMLSpanElement>('delayMsVal');
const batchSize = $<HTMLInputElement>('batchSize');
const batchSizeNum = $<HTMLInputElement>('batchSizeNum');
const batchSizeVal = $<HTMLSpanElement>('batchSizeVal');
const recoveryPassword = $<HTMLInputElement>('recoveryPassword');
const noRecovery = $<HTMLInputElement>('noRecovery');
const executeBtn = $<HTMLButtonElement>('executeBtn');
const feeValue = $<HTMLSpanElement>('feeValue');
const logEntries = $<HTMLDivElement>('logEntries');
const logEmpty = $<HTMLDivElement>('logEmpty');
const recoveryInput = $<HTMLTextAreaElement>('recoveryInput');
const restorePassword = $<HTMLInputElement>('restorePassword');
const continueRecovery = $<HTMLButtonElement>('continueRecovery');
const sweepRecovery = $<HTMLButtonElement>('sweepRecovery');
const refundRecovery = $<HTMLButtonElement>('refundRecovery');

// ═══════════════════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════════════════

let isRunning = false;
let isKeyVisible = false;
const RECOVERY_STORAGE_KEY = 'solana-stealth-transfer:recovery-bundle';

// ═══════════════════════════════════════════════════════════════════════════
//  Utils
// ═══════════════════════════════════════════════════════════════════════════

function parsePrivateKey(input: string): Keypair {
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
  throw new Error('Invalid private key. Use base58 (64-bytes) or JSON array format.');
}

function getRpcUrl(): string {
  const selected = rpcUrl.value;
  if (selected === 'custom') {
    const custom = rpcCustom.value.trim();
    if (!custom) throw new Error('Enter a custom RPC URL.');
    return custom;
  }
  return selected;
}

function isMainnetRpc(url: string): boolean {
  return url === 'https://api.mainnet.solana.com' || !url.includes('devnet') && !url.includes('testnet');
}

function updateFeeEstimate() {
  const hops = parseInt(hopCount.value) || 10;
  const bs = parseInt(batchSize.value) || 5;
  const estimate = estimateTransferFee({ hopCount: hops, batchSize: bs });
  feeValue.textContent = `~${estimate.feeSol.toFixed(9)} SOL`;
}

function clampInt(value: string, min: number, max: number): string {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return String(min);
  return String(Math.min(max, Math.max(min, parsed)));
}

function bindRangeAndNumber({
  range,
  number,
  label,
  format,
  onChange,
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
    label.textContent = format ? format(next) : next;
    onChange?.();
  };
  range.addEventListener('input', () => sync(range.value));
  number.addEventListener('input', () => sync(number.value));
  sync(range.value);
}

function saveRecoveryBundle(bundle: RecoveryBundle) {
  const serialized = JSON.stringify(bundle, null, 2);
  localStorage.setItem(RECOVERY_STORAGE_KEY, serialized);
  recoveryInput.value = serialized;
}

function downloadRecoveryBundle(bundle: RecoveryBundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `stealth-transfer-recovery-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function readRecoveryBundle(): RecoveryBundle {
  const raw = recoveryInput.value.trim() || localStorage.getItem(RECOVERY_STORAGE_KEY);
  if (!raw) throw new Error('Paste a recovery bundle or create one by executing a transfer.');
  return JSON.parse(raw) as RecoveryBundle;
}

async function updateStoredRecoveryBundle({
  password,
  route,
  amountSol,
  batchSizeValue,
  rpcUrlFinal,
  lastCompletedBatch,
  transactions,
}: {
  password: string;
  route: RecoverableRoute;
  amountSol: number;
  batchSizeValue: number;
  rpcUrlFinal: string;
  lastCompletedBatch: number;
  transactions: string[];
}) {
  const bundle = await encryptRecoveryBundle({
    password,
    route,
    amount: amountSol,
    batchSize: batchSizeValue,
    rpcUrl: rpcUrlFinal,
    lastCompletedBatch,
    transactions,
  });
  saveRecoveryBundle(bundle);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Log
// ═══════════════════════════════════════════════════════════════════════════

function log(type: ProgressEvent['type'], msg: string, link?: string) {
  logEmpty!.style.display = 'none';
  logEntries!.classList.add('active');
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
  logEntries!.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Event handlers
// ═══════════════════════════════════════════════════════════════════════════

// Toggle private key visibility
toggleKey.addEventListener('click', () => {
  isKeyVisible = !isKeyVisible;
  privKey.classList.toggle('input--secret', !isKeyVisible);
  toggleKey.textContent = isKeyVisible ? '🙈' : '👁️';
});
privKey.classList.add('input--secret');

// Slider value displays
bindRangeAndNumber({
  range: hopCount,
  number: hopCountNum,
  label: hopCountVal,
  onChange: updateFeeEstimate,
});
bindRangeAndNumber({
  range: delayMs,
  number: delayMsNum,
  label: delayMsVal,
  format: (value) => `${value}ms`,
});
bindRangeAndNumber({
  range: batchSize,
  number: batchSizeNum,
  label: batchSizeVal,
  onChange: updateFeeEstimate,
});
amount.addEventListener('input', updateFeeEstimate);

// RPC custom toggle
rpcUrl.addEventListener('change', () => {
  rpcCustom.classList.toggle('visible', rpcUrl.value === 'custom');
  rpcDot.className = 'dot dot--idle';
});
rpcCustom.classList.toggle('visible', rpcUrl.value === 'custom');

// Test RPC latency
testRpc.addEventListener('click', async () => {
  try {
    const url = getRpcUrl();
    rpcDot.className = 'dot dot--loading';
    const start = performance.now();
    const conn = new Connection(url, { commitment: 'confirmed' });
    await conn.getSlot();
    const ms = (performance.now() - start).toFixed(0);
    rpcDot.className = 'dot dot--ok';
    log('success', `RPC latency: ${ms}ms (${url})`);
  } catch {
    rpcDot.className = 'dot dot--fail';
    log('error', 'RPC unreachable — try another endpoint.');
  }
});

// ─── Execute ─────────────────────────────────────────────────────────────

executeBtn.addEventListener('click', async () => {
  if (isRunning) return;

  // Validate inputs
  const keyRaw = privKey.value.trim();
  const destRaw = destAddr.value.trim();
  const amt = parseFloat(amount.value);
  const hops = parseInt(hopCount.value);
  const bs = parseInt(batchSize.value);
  const dl = parseInt(delayMs.value);

  if (!keyRaw) { log('error', 'Enter the source private key.'); return; }
  if (!destRaw || destRaw.length < 32) { log('error', 'Enter a valid destination address.'); return; }
  if (!amt || amt <= 0) { log('error', 'Enter a valid amount.'); return; }
  if (!hops || hops < 2 || hops > 100) { log('error', 'Hops must be 2–100.'); return; }
  if (!bs || bs < 1 || bs > 8) { log('error', 'Batch size must be 1–8.'); return; }

  // Parse key
  let sourceKeypair: Keypair;
  try {
    sourceKeypair = parsePrivateKey(keyRaw);
    log('info', `Source: ${sourceKeypair.publicKey.toBase58().slice(0, 12)}…`);
  } catch (e) {
    log('error', `Key error: ${(e as Error).message}`);
    return;
  }

  let rpcUrlFinal: string;
  try { rpcUrlFinal = getRpcUrl(); } catch (e) {
    log('error', (e as Error).message);
    return;
  }

  log('info', `Destination: ${destRaw.slice(0, 12)}…`);
  log('info', `Route: ${sourceKeypair.publicKey.toBase58().slice(0, 8)}… → ` +
    `${hops} hops → ${destRaw.slice(0, 8)}…`);

  let route: RecoverableRoute;
  let recoveryBundle: RecoveryBundle | undefined;
  const transactions: string[] = [];

  try {
    new PublicKey(destRaw);
    route = createRecoverableRoute({
      sourcePublicKey: sourceKeypair.publicKey,
      destinationAddress: destRaw,
      hopCount: hops,
    });

    if (noRecovery.checked) {
      const accepted = confirm(
        'Running without a recovery bundle can permanently strand funds if the page closes or a later batch fails. Continue?',
      );
      if (!accepted) return;
      if (isMainnetRpc(rpcUrlFinal)) {
        log('warn', 'Mainnet execution without recovery was explicitly accepted.');
      }
    } else {
      const password = recoveryPassword.value;
      recoveryBundle = await encryptRecoveryBundle({
        password,
        route,
        amount: amt,
        batchSize: bs,
        rpcUrl: rpcUrlFinal,
      });
      saveRecoveryBundle(recoveryBundle);
      downloadRecoveryBundle(recoveryBundle);
      log('success', 'Encrypted recovery bundle created and saved locally.');
    }
  } catch (e) {
    log('error', `Recovery setup error: ${(e as Error).message}`);
    return;
  }

  // Execute
  isRunning = true;
  executeBtn.disabled = true;
  executeBtn.classList.add('btn--loading');
  executeBtn.querySelector('.btn-icon')!.textContent = '⏳';

  try {
    await executeStealthTransfer({
      sourceKeypair,
      destinationAddress: destRaw,
      hopCount: hops,
      amount: amt,
      rpcUrl: rpcUrlFinal,
      delayMs: dl,
      batchSize: bs,
      intermediateKeypairs: route.intermediateKeypairs,
      onBatchConfirmed: async (progress) => {
        transactions.push(progress.txSignature);
        if (!noRecovery.checked) {
          await updateStoredRecoveryBundle({
            password: recoveryPassword.value,
            route,
            amountSol: amt,
            batchSizeValue: bs,
            rpcUrlFinal,
            lastCompletedBatch: progress.lastCompletedBatch,
            transactions,
          });
        }
      },
    }, (ev) => {
      switch (ev.type) {
        case 'info': log('info', ev.message); break;
        case 'success':
          log('success', ev.message, ev.data?.txUrl as string | undefined);
          break;
        case 'warn': log('warn', ev.message); break;
        case 'error': log('error', ev.message); break;
      }
    });

    log('success', 'Transfer complete. All SOL forwarded cleanly.');
  } catch (e) {
    log('error', `${(e as Error).message}`);
  } finally {
    isRunning = false;
    executeBtn.disabled = false;
    executeBtn.classList.remove('btn--loading');
    executeBtn.querySelector('.btn-icon')!.textContent = '🚀';
  }
});

async function runRecovery(action: 'continue' | 'sweep' | 'refund') {
  if (isRunning) return;
  isRunning = true;
  try {
    const bundle = readRecoveryBundle();
    const password = restorePassword.value || recoveryPassword.value;
    const restored = await decryptRecoveryBundle(bundle, password);
    const intermediates = hydrateIntermediateKeypairs(restored);

    if (action === 'continue') {
      const keyRaw = privKey.value.trim();
      if (!keyRaw) throw new Error('Enter the source private key to continue unfinished batches.');
      const sourceKeypair = parsePrivateKey(keyRaw);
      if (sourceKeypair.publicKey.toBase58() !== restored.sourcePublicKey) {
        throw new Error('Source private key does not match the recovery bundle.');
      }
      const startBatch = restored.lastCompletedBatch + 1;
      const estimate = estimateTransferFee({
        hopCount: restored.hopCount,
        batchSize: restored.batchSize,
      });
      if (startBatch >= estimate.batchCount) {
        log('success', 'Recovery bundle already marks all batches complete.');
        return;
      }

      log('info', `Continuing from batch ${startBatch + 1}/${estimate.batchCount}.`);
      await executeStealthTransfer({
        sourceKeypair,
        destinationAddress: restored.destinationAddress,
        hopCount: restored.hopCount,
        amount: restored.amount,
        rpcUrl: restored.rpcUrl,
        delayMs: parseInt(delayMs.value),
        batchSize: restored.batchSize,
        intermediateKeypairs: intermediates,
        startBatch,
        onBatchConfirmed: async (progress) => {
          const route: RecoverableRoute = {
            sourcePublicKey: restored.sourcePublicKey,
            destinationAddress: restored.destinationAddress,
            hopCount: restored.hopCount,
            intermediateKeypairs: intermediates,
            routePublicKeys: restored.routePublicKeys,
          };
          await updateStoredRecoveryBundle({
            password,
            route,
            amountSol: restored.amount,
            batchSizeValue: restored.batchSize,
            rpcUrlFinal: restored.rpcUrl,
            lastCompletedBatch: progress.lastCompletedBatch,
            transactions: [...restored.transactions, progress.txSignature],
          });
        },
      }, (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined));
      log('success', 'Continuation complete.');
      return;
    }

    const targetAddress = action === 'sweep' ? restored.destinationAddress : restored.sourcePublicKey;
    await recoverIntermediateBalances({
      rpcUrl: restored.rpcUrl,
      intermediateKeypairs: intermediates,
      targetAddress,
      onProgress: (ev) => log(ev.type, ev.message, ev.data?.txUrl as string | undefined),
    });
    log('success', action === 'sweep' ? 'Sweep complete.' : 'Refund complete.');
  } catch (e) {
    log('error', `Recovery error: ${(e as Error).message}`);
  } finally {
    isRunning = false;
  }
}

continueRecovery.addEventListener('click', () => void runRecovery('continue'));
sweepRecovery.addEventListener('click', () => void runRecovery('sweep'));
refundRecovery.addEventListener('click', () => void runRecovery('refund'));

// ─── Init ────────────────────────────────────────────────────────────────

const savedRecovery = localStorage.getItem(RECOVERY_STORAGE_KEY);
if (savedRecovery) {
  recoveryInput.value = savedRecovery;
  log('warn', 'Saved recovery bundle detected in this browser.');
}
updateFeeEstimate();
log('info', 'Ready. Configure your transfer and press Execute.');
