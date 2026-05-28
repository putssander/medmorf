// pre-flight-warn.js
// Shows a modal warning before loading a heavy model. The modal explains the
// model's footprint, the device's reported capabilities, and offers a way
// to bail out or proceed. Also exposes a global mutex so two heavy models
// never start downloading / compiling at the same time (a frequent OOM
// trigger on Safari + low-RAM Chrome).

import {
    getCapabilities,
    classifyModelRisk,
    describeMemoryCeiling,
    getRuntimeMemorySnapshot,
} from './device-capabilities.js?v=2026-05-28-resource-1';

const RISK_LABELS = {
    low:      { label: 'Low risk',      color: '#10b981' },
    medium:   { label: 'Medium risk',   color: '#d97706' },
    high:     { label: 'High risk',     color: '#dc2626' },
    critical: { label: 'May crash tab', color: '#7f1d1d' },
    unknown:  { label: 'Unknown size',  color: '#6b7280' },
};

const STORAGE_KEY = 'medmorf:preflight-acknowledged';
function loadAcked() {
    try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
    catch { return new Set(); }
}
function saveAcked(set) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set))); }
    catch { /* private mode */ }
}

let modalRoot = null;
function ensureRoot() {
    if (modalRoot) return modalRoot;
    const root = document.createElement('div');
    root.id = 'preflightRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;';
    document.body.appendChild(root);
    modalRoot = root;
    return root;
}

function fmtSize(mb) {
    if (!mb || mb <= 0) return '?';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return Math.round(mb) + ' MB';
}

function buildModal({ title, model, sizeMB, risk, snap, why }) {
    const tier = RISK_LABELS[risk] || RISK_LABELS.unknown;
    const runtime = getRuntimeMemorySnapshot();
    const ceiling = describeMemoryCeiling(snap, runtime);
    const jsHeap = runtime.jsHeapSupported
        ? `${fmtSize(runtime.jsHeapUsedMB)} / ${fmtSize(runtime.jsHeapLimitMB)}`
        : 'Not exposed by this browser';
    const safeHeadroom = sizeMB > 0
        ? `${fmtSize(Math.max(0, ceiling.safeModelCeilingMB - sizeMB))} after this model`
        : 'Unknown';
    const wgpu = snap?.webgpu?.supported
        ? `WebGPU ${snap.webgpu.adapterInfo?.vendor || ''} (max buffer ${fmtSize(snap.webgpu.maxBufferSizeMB)})`
        : 'WebGPU not available — will fall back to WASM (much slower)';
    const ios = snap?.isIosSafari ? '<div class="pf-warn">⚠️ iOS Safari has a strict ~1.5 GB per-tab memory cap. Tabs that exceed it crash.</div>' : '';
    const visibilityNote = '<div class="pf-note">Browsers do not expose exact total tab memory or total VRAM. Reported values are shown when available; the model ceiling is a conservative estimate.</div>';

    return `
        <div class="pf-overlay" data-action="cancel"></div>
        <div class="pf-card" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="pf-head">
                <h3>${title}</h3>
                <span class="pf-tier" style="background:${tier.color}">${tier.label}</span>
            </div>
            <div class="pf-body">
                <div class="pf-row"><span class="pf-k">Model</span><span class="pf-v">${model}</span></div>
                <div class="pf-row"><span class="pf-k">Approx download</span><span class="pf-v">${fmtSize(sizeMB)}</span></div>
                <div class="pf-row"><span class="pf-k">Device RAM</span><span class="pf-v">${snap?.deviceMemoryGB ?? '?'} GB (reported)</span></div>
                <div class="pf-row"><span class="pf-k">CPU cores</span><span class="pf-v">${snap?.cores ?? '?'}</span></div>
                <div class="pf-row"><span class="pf-k">Backend</span><span class="pf-v">${wgpu}</span></div>
                <div class="pf-row"><span class="pf-k">JS heap now</span><span class="pf-v">${jsHeap}</span></div>
                <div class="pf-row"><span class="pf-k">Main bottleneck</span><span class="pf-v">${ceiling.bottleneck.label}: ${fmtSize(ceiling.bottleneck.valueMB)}</span></div>
                <div class="pf-row"><span class="pf-k">Model headroom</span><span class="pf-v">${safeHeadroom}</span></div>
                ${snap?.storageQuotaGB ? `<div class="pf-row"><span class="pf-k">Cache quota</span><span class="pf-v">${snap.storageQuotaGB.toFixed(1)} GB</span></div>` : ''}
                ${ios}
                ${visibilityNote}
                ${why ? `<p class="pf-why">${why}</p>` : ''}
                <label class="pf-skip"><input type="checkbox" data-action="dont-show"> Don't show this warning again for this model</label>
            </div>
            <div class="pf-foot">
                <button class="pf-btn pf-btn-ghost" data-action="cancel">Cancel</button>
                <button class="pf-btn" data-action="proceed">Continue</button>
            </div>
        </div>
    `;
}

function injectStylesOnce() {
    if (document.getElementById('preflightStyles')) return;
    const s = document.createElement('style');
    s.id = 'preflightStyles';
    s.textContent = `
        #preflightRoot .pf-overlay { position: absolute; inset: 0; background: rgba(15,23,42,0.55); }
        #preflightRoot .pf-card {
            position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
            width: min(520px, 92vw); background: #fff; border-radius: 12px; padding: 1.25rem 1.4rem;
            box-shadow: 0 20px 50px rgba(0,0,0,0.25); font-family: inherit;
        }
        #preflightRoot .pf-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
        #preflightRoot .pf-head h3 { margin: 0; font-size: 1.1rem; }
        #preflightRoot .pf-tier { color: #fff; padding: 0.2rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.02em; }
        #preflightRoot .pf-body { margin: 0.9rem 0; font-size: 0.9rem; color: #1f2937; }
        #preflightRoot .pf-row { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.25rem 0; border-bottom: 1px solid #f1f5f9; }
        #preflightRoot .pf-row:last-of-type { border-bottom: 0; }
        #preflightRoot .pf-k { color: #6b7280; }
        #preflightRoot .pf-v { font-weight: 600; text-align: right; }
        #preflightRoot .pf-warn { margin-top: 0.6rem; padding: 0.5rem 0.6rem; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 0.83rem; }
        #preflightRoot .pf-note { margin-top: 0.6rem; padding: 0.5rem 0.6rem; border-radius: 6px; background: #eff6ff; color: #1e40af; font-size: 0.8rem; line-height: 1.35; }
        #preflightRoot .pf-why { margin: 0.6rem 0 0; color: #475569; font-size: 0.85rem; }
        #preflightRoot .pf-skip { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.7rem; font-size: 0.82rem; color: #6b7280; }
        #preflightRoot .pf-foot { display: flex; justify-content: flex-end; gap: 0.5rem; }
        #preflightRoot .pf-btn { background: #3b82f6; color: #fff; border: 0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
        #preflightRoot .pf-btn-ghost { background: #fff; color: #374151; border: 1px solid #e5e7eb; }
        #preflightRoot .pf-btn:hover { filter: brightness(1.05); }
    `;
    document.head.appendChild(s);
}

/**
 * Show a pre-flight warning. Resolves to true if the user proceeded, false
 * if they cancelled. If the user has previously checked "don't show again"
 * for the same `key`, resolves immediately to true.
 *
 * @param {object} opts
 * @param {string} opts.key       Stable id used for the "skip in future" state. Required.
 * @param {string} opts.title     Modal title.
 * @param {string} opts.model     Human-readable model id.
 * @param {number} opts.sizeMB    Approximate weight size in MB.
 * @param {string} [opts.why]     Extra explanation paragraph.
 * @param {boolean} [opts.force]  If true, ignore the saved skip preference and always show.
 */
export async function preflightWarn({ key, title, model, sizeMB, why, force }) {
    const acked = loadAcked();
    if (!force && acked.has(key)) return true;

    injectStylesOnce();
    const snap = await getCapabilities();
    const risk = classifyModelRisk(sizeMB, snap);

    // Auto-allow tiny low-risk loads even without a stored ack.
    if (!force && risk === 'low' && (sizeMB || 0) < 200) return true;

    const root = ensureRoot();
    root.innerHTML = buildModal({ title, model, sizeMB, risk, snap, why });
    root.style.display = 'block';

    return new Promise((resolve) => {
        const handler = (e) => {
            const action = e.target.closest('[data-action]')?.getAttribute('data-action');
            if (action === 'cancel') {
                root.style.display = 'none';
                root.removeEventListener('click', handler);
                resolve(false);
            } else if (action === 'proceed') {
                const skip = root.querySelector('input[data-action="dont-show"]');
                if (skip && skip.checked) {
                    acked.add(key);
                    saveAcked(acked);
                }
                root.style.display = 'none';
                root.removeEventListener('click', handler);
                resolve(true);
            }
        };
        root.addEventListener('click', handler);
    });
}

// ── Heavy-load mutex ───────────────────────────────────────────────────────────
// Prevents two large models from downloading / compiling at the same time,
// which is a common cause of "out of memory" in the WebGPU layer when one
// adapter is shared between Transformers.js and WebLLM.

let _chain = Promise.resolve();
let _currentLabel = null;
const _waiters = new Set();

export function getActiveHeavyLoad() {
    return _currentLabel;
}
export function onHeavyLoadChange(fn) {
    _waiters.add(fn);
    return () => _waiters.delete(fn);
}

export function withHeavyLoadLock(label, task) {
    const next = _chain.then(async () => {
        _currentLabel = label;
        _waiters.forEach(fn => { try { fn(label); } catch { /* ignore */ } });
        try {
            return await task();
        } finally {
            _currentLabel = null;
            _waiters.forEach(fn => { try { fn(null); } catch { /* ignore */ } });
        }
    });
    // Don't let one failure poison the chain.
    _chain = next.catch(() => {});
    return next;
}

// Convenience: clear all "don't show again" decisions (called from the
// Storage / Settings tab when the user clicks "Reset warnings").
export function resetPreflightAcks() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
