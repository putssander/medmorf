// lifecycle-manager.js
// Centralizes "heavy resource" lifecycle: idle eviction, tab-hide cleanup,
// WebGPU device-lost notifications. Handlers register their loaded models
// here so memory can be reclaimed automatically when the tab is hidden or
// idle, and a friendly toast appears when the GPU drops.

const _models = new Map(); // name -> { dispose, lastUsed, sizeMB }
const _listeners = new Set();

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const HIDE_GRACE_MS = 60 * 1000;        // dispose 60s after tab hidden

let hideTimer = null;
let idleTimer = null;

function notify(event, payload) {
    _listeners.forEach(fn => { try { fn(event, payload); } catch (e) { console.warn(e); } });
}

export function onLifecycleEvent(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

/**
 * Register a loaded heavy model. The dispose function will be called on
 * idle / tab hide. `sizeMB` is informational (used by the toast UI).
 */
export function registerLoadedModel(name, dispose, { sizeMB = 0, autoEvict = true } = {}) {
    if (typeof dispose !== 'function') return;
    _models.set(name, { dispose, sizeMB, lastUsed: Date.now(), autoEvict });
    scheduleIdleCheck();
}

export function unregisterLoadedModel(name) {
    _models.delete(name);
    if (_models.size === 0 && idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

export function markModelUsed(name) {
    const rec = _models.get(name);
    if (rec) {
        rec.lastUsed = Date.now();
        scheduleIdleCheck();
    }
}

export function listLoadedModels() {
    return Array.from(_models.entries()).map(([name, r]) => ({
        name, sizeMB: r.sizeMB, lastUsed: r.lastUsed, idleMs: Date.now() - r.lastUsed,
    }));
}

function scheduleIdleCheck() {
    if (idleTimer) return;
    if (_models.size === 0) return;
    idleTimer = setTimeout(() => {
        idleTimer = null;
        const now = Date.now();
        for (const [name, rec] of _models.entries()) {
            if (rec.autoEvict && (now - rec.lastUsed) >= IDLE_TIMEOUT_MS) {
                Promise.resolve().then(() => rec.dispose()).catch(e => console.warn('idle dispose failed', name, e));
                _models.delete(name);
                notify('idle-evicted', { name });
            }
        }
        scheduleIdleCheck();
    }, 60 * 1000);
}

// ── Tab-hide handling ──────────────────────────────────────────────────────────
// On long hides we proactively dispose to free memory (especially important
// on iOS where Safari can kill background tabs). On show, we just notify so
// the UI can prompt the user to reload models if needed.
function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            hideTimer = null;
            const evicted = [];
            for (const [name, rec] of _models.entries()) {
                if (rec.autoEvict) {
                    Promise.resolve().then(() => rec.dispose()).catch(() => {});
                    _models.delete(name);
                    evicted.push(name);
                }
            }
            if (evicted.length) notify('hide-evicted', { models: evicted });
        }, HIDE_GRACE_MS);
    } else {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }
}
document.addEventListener('visibilitychange', handleVisibilityChange);

// ── WebGPU device-lost ─────────────────────────────────────────────────────────
// We can't directly hook into WebLLM's GPUDevice, but we can listen for the
// "uncapturederror" pattern via a globally-attached adapter. Most useful
// signal in practice: a generic "webgpu lost" toast triggered by the engine
// throwing during inference. Handlers can call `reportWebGPULost(msg)` to
// surface the standard toast.

let toastEl = null;
function ensureToast() {
    if (toastEl) return toastEl;
    const el = document.createElement('div');
    el.id = 'lifecycleToast';
    el.style.cssText = `
        position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
        background: #1f2937; color: #f9fafb; padding: 0.75rem 1rem; border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25); font-size: 0.9rem; z-index: 99998;
        max-width: 92vw; display: none;
    `;
    document.body.appendChild(el);
    toastEl = el;
    return el;
}

export function showToast(message, { duration = 5000, action } = {}) {
    const el = ensureToast();
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (action) {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.style.cssText = 'margin-left: 0.75rem; background: #3b82f6; color: #fff; border: 0; padding: 0.3rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem;';
        btn.onclick = () => { action.onClick(); el.style.display = 'none'; };
        el.appendChild(btn);
    }
    el.style.display = 'block';
    if (duration > 0) {
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.display = 'none'; }, duration);
    }
}

export function reportWebGPULost(detail = '') {
    // Drop all loaded models from the registry — the GPU device is gone.
    for (const [name, rec] of _models.entries()) {
        try { rec.dispose(); } catch { /* ignore */ }
        _models.delete(name);
    }
    notify('webgpu-lost', { detail });
    showToast(
        '⚠️ The GPU dropped this tab. Models have been unloaded — please reload to retry.',
        { duration: 0, action: { label: 'Reload', onClick: () => location.reload() } }
    );
}

// Best-effort global hook: catch unhandled WebGPU errors that bubble up.
window.addEventListener('error', (ev) => {
    const msg = String(ev.message || '');
    if (/GPU|WebGPU|device.*lost|out of memory/i.test(msg)) {
        reportWebGPULost(msg);
    }
});
window.addEventListener('unhandledrejection', (ev) => {
    const msg = String(ev.reason?.message || ev.reason || '');
    if (/GPU.*lost|WebGPU.*lost|out of memory/i.test(msg)) {
        reportWebGPULost(msg);
    }
});
