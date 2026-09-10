// pre-flight-warn.js
// Shows a compact confirmation before loading a heavy model. Essential download
// and privacy information stays visible; technical device data is optional.
// Also exposes a global mutex so two heavy models
// never start downloading / compiling at the same time (a frequent OOM
// trigger on Safari + low-RAM Chrome).

import {
    getCapabilities,
    classifyModelRisk,
    describeMemoryCeiling,
    getRuntimeMemorySnapshot,
} from './device-capabilities.js?v=2026-05-28-resource-1';

const RISK_MESSAGES = {
    medium: 'This may take a while on this device.',
    high: 'This model may be too large for this device. A smaller model is safer.',
    critical: 'This model may close this tab. Choose a smaller model if available.',
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
    const runtime = getRuntimeMemorySnapshot();
    const ceiling = describeMemoryCeiling(snap, runtime);
    const safeHeadroom = sizeMB > 0
        ? `${fmtSize(Math.max(0, ceiling.safeModelCeilingMB - sizeMB))} after this model`
        : 'Unknown';
    const wgpu = snap?.webgpu?.supported
        ? 'WebGPU available'
        : 'Standard browser processing';
    const riskMessage = RISK_MESSAGES[risk] || '';

    return `
        <div class="pf-overlay" data-action="cancel"></div>
        <div class="pf-card" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="pf-head">
                <h3>${title}</h3>
                <button class="pf-close" type="button" data-action="cancel" aria-label="Close">×</button>
            </div>
            <div class="pf-body">
                <p class="pf-size"><strong>${fmtSize(sizeMB)}</strong> download</p>
                <p class="pf-privacy">Stored in this browser. Your content stays on this device.</p>
                ${riskMessage ? `<p class="pf-caution" data-risk="${risk}">${riskMessage}</p>` : ''}
                <details class="pf-details">
                    <summary>Details</summary>
                    <div class="pf-details-body">
                        <div class="pf-row"><span class="pf-k">Model</span><span class="pf-v">${model}</span></div>
                        <div class="pf-row"><span class="pf-k">Device memory</span><span class="pf-v">${snap?.deviceMemoryGB ? `${snap.deviceMemoryGB} GB reported` : 'Not reported'}</span></div>
                        <div class="pf-row"><span class="pf-k">Processing</span><span class="pf-v">${wgpu}</span></div>
                        <div class="pf-row"><span class="pf-k">Estimated headroom</span><span class="pf-v">${safeHeadroom}</span></div>
                        ${why ? `<p class="pf-why">${why}</p>` : ''}
                    </div>
                </details>
                <label class="pf-skip"><input type="checkbox" data-action="dont-show"> Don't ask again for this model</label>
            </div>
            <div class="pf-foot">
                <button class="pf-btn pf-btn-ghost" type="button" data-action="cancel">Not now</button>
                <button class="pf-btn" type="button" data-action="proceed">Download model</button>
            </div>
        </div>
    `;
}

function injectStylesOnce() {
    if (document.getElementById('preflightStyles')) return;
    const s = document.createElement('style');
    s.id = 'preflightStyles';
    s.textContent = `
        #preflightRoot .pf-overlay { position: absolute; inset: 0; background: rgba(15,23,42,0.38); backdrop-filter: blur(3px); }
        #preflightRoot .pf-card {
            position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
            width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
            background: #fff; border: 1px solid rgba(15,23,42,0.08); border-radius: 18px; padding: 1.25rem;
            box-shadow: 0 24px 64px rgba(15,23,42,0.22); font-family: inherit; color: #102033;
        }
        #preflightRoot .pf-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
        #preflightRoot .pf-head h3 { margin: 0; font-size: 1.15rem; line-height: 1.25; letter-spacing: -0.015em; }
        #preflightRoot .pf-close { width: 30px; height: 30px; flex: 0 0 30px; border: 0; border-radius: 50%; background: #f1f5f9; color: #64748b; font: 500 1.25rem/1 inherit; cursor: pointer; }
        #preflightRoot .pf-body { margin: 1rem 0 1.1rem; font-size: 0.9rem; }
        #preflightRoot .pf-size { margin: 0; color: #64748b; }
        #preflightRoot .pf-size strong { color: #102033; font-size: 1.15rem; }
        #preflightRoot .pf-privacy { margin: 0.75rem 0 0; color: #137a50; line-height: 1.45; }
        #preflightRoot .pf-caution { margin: 0.75rem 0 0; padding: 0.65rem 0.75rem; border-radius: 10px; background: #fff7ed; color: #9a3412; line-height: 1.4; }
        #preflightRoot .pf-caution[data-risk="critical"] { background: #fef2f2; color: #b91c1c; }
        #preflightRoot .pf-details { margin-top: 0.8rem; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
        #preflightRoot .pf-details summary { padding: 0.65rem 0; color: #64748b; font-size: 0.84rem; cursor: pointer; }
        #preflightRoot .pf-details-body { padding: 0 0 0.7rem; }
        #preflightRoot .pf-row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.28rem 0; font-size: 0.8rem; }
        #preflightRoot .pf-k { color: #64748b; }
        #preflightRoot .pf-v { max-width: 62%; color: #334155; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
        #preflightRoot .pf-why { margin: 0.55rem 0 0; color: #64748b; font-size: 0.8rem; line-height: 1.4; }
        #preflightRoot .pf-skip { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; font-size: 0.8rem; color: #64748b; }
        #preflightRoot .pf-skip input { width: 16px; height: 16px; margin: 0; accent-color: #2563eb; }
        #preflightRoot .pf-foot { display: flex; justify-content: flex-end; gap: 0.55rem; }
        #preflightRoot .pf-btn { min-height: 42px; border: 0; border-radius: 10px; padding: 0.65rem 1rem; background: #2563eb; color: #fff; font: 650 0.9rem/1 inherit; cursor: pointer; }
        #preflightRoot .pf-btn-ghost { background: transparent; color: #475569; }
        #preflightRoot .pf-btn:hover { filter: brightness(0.97); }
        #preflightRoot .pf-btn:focus-visible, #preflightRoot .pf-close:focus-visible, #preflightRoot summary:focus-visible { outline: 3px solid rgba(37,99,235,0.3); outline-offset: 2px; }
        @media (max-width: 420px) {
            #preflightRoot .pf-card { padding: 1rem; border-radius: 16px; }
            #preflightRoot .pf-foot { display: grid; grid-template-columns: 1fr 1.4fr; }
            #preflightRoot .pf-btn { width: 100%; padding-inline: 0.75rem; }
        }
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
    _lastPreflight = { model, sizeMB: sizeMB || 0, at: Date.now() };
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
let _currentSizeMB = 0;
let _lastPreflight = null; // {model, sizeMB, at} from the most recent preflightWarn()
const _waiters = new Set();

export function getActiveHeavyLoad() {
    return _currentLabel;
}
// Label + approximate weight size of the load in flight (used by the memory bar
// so a model counts towards memory while it is still downloading/compiling).
export function getActiveHeavyLoadInfo() {
    return _currentLabel ? { label: _currentLabel, sizeMB: _currentSizeMB } : null;
}
export function onHeavyLoadChange(fn) {
    _waiters.add(fn);
    return () => _waiters.delete(fn);
}

export function withHeavyLoadLock(label, task, { sizeMB } = {}) {
    // Fall back to the size announced by a preflightWarn() in the last minute.
    const fallback = _lastPreflight && Date.now() - _lastPreflight.at < 60_000 ? _lastPreflight.sizeMB : 0;
    const next = _chain.then(async () => {
        _currentLabel = label;
        _currentSizeMB = sizeMB ?? fallback;
        _waiters.forEach(fn => { try { fn(label); } catch { /* ignore */ } });
        try {
            return await task();
        } finally {
            _currentLabel = null;
            _currentSizeMB = 0;
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
