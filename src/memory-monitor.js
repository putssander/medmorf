// memory-monitor.js
// Always-visible, live memory bar at the top of the app plus per-browser
// guidance. Browsers expose very little about real tab memory, so this module
// combines every signal it can get and is explicit about what is measured
// versus estimated:
//
//   measured  – performance.measureUserAgentSpecificMemory() (only when the
//               page is cross-origin isolated) or performance.memory (Chromium
//               JS heap only, deprecated but still the best live signal).
//   estimated – weights of the models currently registered as loaded
//               (lifecycle-manager). These mostly live in WASM / WebGPU memory
//               and are invisible to the JS heap counters.
//
// The bar compares (measured + estimated) against a conservative per-tab
// "guardrail" derived from the browser family, reported device RAM and the
// existing safe-model ceiling. It is a guardrail, not a hard limit.

import {
    getCapabilities,
    getCapabilitiesSync,
    getRuntimeMemorySnapshot,
    safeModelCeilingMB,
} from './device-capabilities.js?v=2026-05-28-resource-1';
import { listLoadedModels, onLifecycleEvent } from './lifecycle-manager.js?v=2026-05-21-stability-1';
import { getActiveHeavyLoadInfo, onHeavyLoadChange } from './pre-flight-warn.js?v=2026-08-30-memory-bar-2';

const POLL_MS = 1000;
const IOS_TAB_GUARDRAIL_MB = 1500;   // WebKit kills tabs well below device RAM
const MOBILE_TAB_GUARDRAIL_MB = 2048;
const DESKTOP_MIN_GUARDRAIL_MB = 2048;
const DESKTOP_MAX_GUARDRAIL_MB = 8192;

// ── Browser detection ─────────────────────────────────────────────────────────

export function detectBrowser() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
    const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1; // iPadOS "desktop" UA
    const isIos = /iPad|iPhone|iPod/.test(ua) || touchMac;
    const isAndroid = /Android/.test(ua);
    const isMac = /Macintosh|Mac OS X/.test(ua) && !isIos;
    const isWindows = /Windows/.test(ua);
    const isLinux = /Linux/.test(ua) && !isAndroid;
    const isMobile = isIos || isAndroid || /Mobi/.test(ua);

    let name = 'Unknown';
    let engine = 'Unknown';
    let version = '';
    const v = (re) => { const m = ua.match(re); return m ? m[1] : ''; };

    if (isIos) {
        // Every iOS browser is WebKit under the hood.
        engine = 'WebKit';
        if (/CriOS/.test(ua)) { name = 'Chrome (iOS)'; version = v(/CriOS\/(\d+)/); }
        else if (/FxiOS/.test(ua)) { name = 'Firefox (iOS)'; version = v(/FxiOS\/(\d+)/); }
        else if (/EdgiOS/.test(ua)) { name = 'Edge (iOS)'; version = v(/EdgiOS\/(\d+)/); }
        else { name = 'Safari (iOS)'; version = v(/Version\/(\d+)/); }
    } else if (/Edg\//.test(ua)) { name = 'Edge'; engine = 'Chromium'; version = v(/Edg\/(\d+)/); }
    else if (/OPR\//.test(ua)) { name = 'Opera'; engine = 'Chromium'; version = v(/OPR\/(\d+)/); }
    else if (/SamsungBrowser/.test(ua)) { name = 'Samsung Internet'; engine = 'Chromium'; version = v(/SamsungBrowser\/(\d+)/); }
    else if (/Firefox\//.test(ua)) { name = 'Firefox'; engine = 'Gecko'; version = v(/Firefox\/(\d+)/); }
    else if (/Chrome\//.test(ua)) { name = 'Chrome'; engine = 'Chromium'; version = v(/Chrome\/(\d+)/); }
    else if (/Safari\//.test(ua)) { name = 'Safari'; engine = 'WebKit'; version = v(/Version\/(\d+)/); }

    const os = isIos ? (touchMac || /iPad/.test(ua) ? 'iPadOS' : 'iOS')
        : isAndroid ? 'Android'
        : isMac ? 'macOS'
        : isWindows ? 'Windows'
        : isLinux ? 'Linux'
        : 'Unknown OS';

    return { name, engine, version, os, isIos, isAndroid, isMac, isMobile, ua };
}

// Per-browser guidance shown next to the bar and in the details panel.
export function browserAdvice(b = detectBrowser(), snap = getCapabilitiesSync()) {
    const webgpu = !!snap?.webgpu?.supported;
    const heap = typeof performance !== 'undefined' && !!performance.memory;
    if (b.isIos) {
        return {
            level: 'warn',
            short: 'iOS/iPadOS: memory is tightly capped — prefer small models',
            long: 'All iOS browsers use WebKit and the OS terminates pages that use too much memory. Live memory is not exposed, so the bar is an estimate. Use the smallest model variants, keep one tab open and keep Medmorf in the foreground. For large models use Chrome or Edge on a desktop.',
            recommended: 'Chrome / Edge on a desktop for large models',
        };
    }
    if (b.engine === 'Chromium') {
        return {
            level: 'ok',
            short: `${b.name}: recommended — live JS heap ${heap ? 'is measured' : 'not exposed'}${webgpu ? ', WebGPU on' : ', WebGPU unavailable'}`,
            long: `${b.name} exposes the JavaScript heap so the bar shows real heap usage. Model weights live in WebAssembly and WebGPU memory outside that heap, so they are added as an estimate. ${webgpu ? 'WebGPU is available.' : 'WebGPU is not available — models fall back to slower WASM execution and use more RAM.'}`,
            recommended: 'This browser',
        };
    }
    if (b.engine === 'WebKit') {
        return {
            level: 'info',
            short: `Safari ${b.version || ''}: supported, memory is dynamic — Chrome/Edge recommended for large models`.replace('  ', ' '),
            long: 'Safari manages memory per web process and does not expose heap or device RAM to pages, so the bar is estimated from loaded models only. WebGPU is available from Safari 26 (Apple Silicon works best). For the largest models Chrome or Edge is recommended.',
            recommended: 'Chrome / Edge for large models',
        };
    }
    if (b.engine === 'Gecko') {
        return {
            level: 'info',
            short: `Firefox: supported — no live memory readout${webgpu ? ', WebGPU on' : ', WebGPU unavailable'}`,
            long: `Firefox does not expose the JS heap or device RAM, so the bar is estimated from loaded models. Its JavaScript GC heap is nominally capped around 4 GB. ${webgpu ? 'WebGPU is available.' : 'WebGPU is not available on this platform/version — LLM features will be slow or unavailable.'} Chrome or Edge is recommended for large models.`,
            recommended: 'Chrome / Edge for large models',
        };
    }
    return {
        level: 'info',
        short: 'Unknown browser — Chrome or Edge recommended',
        long: 'This browser could not be identified. Chrome or Edge give the most predictable results for in-browser AI.',
        recommended: 'Chrome / Edge',
    };
}

// ── Measurement ───────────────────────────────────────────────────────────────

let _uaMemoryMB = null;      // last measureUserAgentSpecificMemory() result
let _uaMemoryPending = false;

async function sampleUserAgentMemory() {
    if (_uaMemoryPending) return;
    if (typeof performance === 'undefined' || typeof performance.measureUserAgentSpecificMemory !== 'function') return;
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) return;
    _uaMemoryPending = true;
    try {
        const r = await performance.measureUserAgentSpecificMemory();
        _uaMemoryMB = r.bytes / (1024 * 1024);
    } catch {
        _uaMemoryMB = null;
    } finally {
        _uaMemoryPending = false;
    }
}

function guardrailMB(snap, runtime, browser) {
    if (browser.isIos || snap?.isIosSafari) return IOS_TAB_GUARDRAIL_MB;
    if (browser.isMobile) return MOBILE_TAB_GUARDRAIL_MB;
    const ramMB = (snap?.deviceMemoryGB || 4) * 1024;
    // One tab realistically gets a fraction of RAM before the OS/browser
    // starts killing it; keep in line with safeModelCeilingMB plus heap use.
    let g = Math.min(DESKTOP_MAX_GUARDRAIL_MB, Math.max(DESKTOP_MIN_GUARDRAIL_MB, ramMB * 0.6));
    if (runtime?.jsHeapLimitMB) {
        // Heap limit + room for model weights outside the heap.
        g = Math.max(g, Math.min(DESKTOP_MAX_GUARDRAIL_MB, runtime.jsHeapLimitMB * 0.5 + safeModelCeilingMB(snap)));
    }
    return Math.round(g);
}

/**
 * Current best-effort memory picture for this tab.
 * All numbers in MB. `source` tells the UI how trustworthy `usedMB` is.
 */
export function getMemoryEstimate() {
    const snap = getCapabilitiesSync();
    const runtime = getRuntimeMemorySnapshot();
    const browser = detectBrowser();
    const models = listLoadedModels();
    const modelsMB = models.reduce((a, m) => a + (m.sizeMB || 0), 0);
    const loadingInfo = getActiveHeavyLoadInfo();
    const loading = loadingInfo?.label || null;
    const loadingMB = loadingInfo?.sizeMB || 0;

    let heapMB = 0;
    let source = 'estimated';
    let sourceLabel = 'Estimated from loaded models (this browser hides live memory)';

    if (_uaMemoryMB != null) {
        heapMB = _uaMemoryMB;
        source = 'measured';
        sourceLabel = 'Measured by browser (measureUserAgentSpecificMemory)';
    } else if (runtime.jsHeapSupported) {
        heapMB = runtime.jsHeapUsedMB || 0;
        source = 'heap';
        sourceLabel = 'Live JS heap + estimated model weights (WASM/GPU)';
    }

    const usedMB = heapMB + modelsMB + loadingMB;
    const limitMB = guardrailMB(snap, runtime, browser);
    const ratio = limitMB > 0 ? usedMB / limitMB : 0;
    const level = ratio >= 0.85 ? 'critical' : ratio >= 0.65 ? 'warn' : 'ok';

    return {
        usedMB, heapMB, modelsMB, loadingMB, limitMB, ratio, level, source, sourceLabel,
        heapLimitMB: runtime.jsHeapLimitMB || null,
        models, loading, browser, snap,
    };
}

// ── UI ────────────────────────────────────────────────────────────────────────

function fmt(mb) {
    if (mb == null || !isFinite(mb)) return '?';
    if (mb >= 1024) return (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + ' GB';
    return Math.round(mb) + ' MB';
}
function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const LEVEL_TEXT = {
    ok: 'OK',
    warn: 'High — avoid loading another model',
    critical: 'Critical — tab may crash; unload models or close other tabs',
};

function buildDetails(est) {
    const b = est.browser;
    const adv = browserAdvice(b, est.snap);
    const snap = est.snap;
    const ramKnown = typeof navigator !== 'undefined' && navigator.deviceMemory;
    const rows = [
        ['Browser', `${b.name} ${b.version || ''} · ${b.os}`],
        ['Approx. system memory', ramKnown ? `${navigator.deviceMemory} GB (coarse bucket)` : 'Not exposed by this browser'],
        ['JS heap limit', est.heapLimitMB ? fmt(est.heapLimitMB) : 'Not exposed by this browser'],
        ['Live JS heap', est.source === 'estimated' ? 'Not exposed' : fmt(est.heapMB)],
        ['Loaded model weights', est.models.length ? est.models.map(m => `${esc(m.name)} ${fmt(m.sizeMB)}`).join(', ') : 'none'],
        ['Loading now', est.loading ? `${esc(est.loading)} (~${fmt(est.loadingMB)})` : '—'],
        ['WebGPU', snap?.webgpu?.supported ? `Available${snap.webgpu.adapterInfo?.vendor ? ' · ' + esc(snap.webgpu.adapterInfo.vendor) : ''}` : 'Not available (WASM fallback, slower)'],
        ['Tab memory guardrail', `${fmt(est.limitMB)} (estimated, all pools combined)`],
        ['Largest single model', `${fmt(safeModelCeilingMB(snap))} — ${snap?.webgpu?.supported ? 'bounded by the WebGPU max buffer size' : 'CPU/WASM path: one model must stay well under the ~2–4 GB WebAssembly memory limit'}`],
        ['Recommended browser', adv.recommended],
    ];
    const table = `
        <table class="mm-table">
            <thead><tr><th>Browser</th><th>Memory handling</th><th>Large local AI models</th></tr></thead>
            <tbody>
                <tr><td>Chrome</td><td>Up to ~4 GB JS heap + separate WASM/GPU memory; live heap readout</td><td>🟢 Recommended</td></tr>
                <tr><td>Edge</td><td>Same engine as Chrome</td><td>🟢 Recommended</td></tr>
                <tr><td>Safari 26+</td><td>Dynamic per-tab/process memory; no live readout</td><td>🟡 Supported, device dependent</td></tr>
                <tr><td>Firefox</td><td>~4 GB nominal JS GC heap; no live readout</td><td>🟡 Supported, check WebGPU</td></tr>
                <tr><td>Mobile Safari / iOS</td><td>OS-controlled, tightly capped</td><td>🟠 Prefer smaller models</td></tr>
            </tbody>
        </table>`;
    return `
        <div class="mm-details-grid">
            <div>
                <h4>Your environment</h4>
                <dl class="mm-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
                <p class="mm-advice-long">${esc(adv.long)}</p>
            </div>
            <div>
                <h4>Browser guidance</h4>
                ${table}
                <p class="mm-note">${esc(est.sourceLabel)}. A tab never gets the machine's full RAM: the JavaScript heap is capped at ~4 GB, each WebAssembly module at ~4 GB (in practice 2–3 GB before the runtime fails), and WebGPU buffers by the adapter's max buffer size and free GPU memory; on iOS the whole page is limited to roughly 1.5 GB. The guardrail above is the sum a tab can realistically hold, not what one model may use.</p>
            </div>
        </div>`;
}

let _root = null;
let _els = null;
let _open = false;
let _timer = null;
let _lastLevel = null;

function render() {
    if (!_els) return;
    const est = getMemoryEstimate();
    const pct = Math.max(0, Math.min(100, est.ratio * 100));
    const heapPct = est.limitMB ? Math.min(pct, (est.heapMB / est.limitMB) * 100) : 0;

    _root.dataset.level = est.level;
    _root.dataset.source = est.source;
    _els.fillHeap.style.width = heapPct.toFixed(1) + '%';
    _els.fillModels.style.width = (pct - heapPct).toFixed(1) + '%';
    _els.bar.setAttribute('aria-valuenow', Math.round(pct));

    const approx = est.source === 'estimated' ? '≈' : '';
    _els.value.textContent = `${approx}${fmt(est.usedMB)} / ${fmt(est.limitMB)}`;
    _els.status.textContent = est.loading
        ? `Loading ${est.loading}…`
        : (est.source === 'estimated' && est.usedMB === 0)
            ? 'No models loaded — live memory not exposed by this browser'
            : LEVEL_TEXT[est.level];
    _els.status.classList.toggle('is-loading', !!est.loading);

    const adv = browserAdvice(est.browser, est.snap);
    _els.advice.textContent = adv.short;
    _els.advice.dataset.level = adv.level;

    if (_open) _els.details.innerHTML = buildDetails(est);

    if (est.level !== _lastLevel) {
        _lastLevel = est.level;
        _root.dispatchEvent(new CustomEvent('memory-level', { bubbles: true, detail: est }));
    }
}

function tick() {
    sampleUserAgentMemory();
    render();
}

function mount(container) {
    container.innerHTML = `
        <button type="button" class="mm-toggle" aria-expanded="false" title="Show memory details and browser advice">
            <span class="mm-label">Memory</span>
            <span class="mm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Estimated tab memory">
                <span class="mm-fill mm-fill-heap"></span><span class="mm-fill mm-fill-models"></span>
            </span>
            <span class="mm-value">…</span>
            <span class="mm-status"></span>
            <span class="mm-advice"></span>
            <span class="mm-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="mm-details" hidden></div>
    `;
    _root = container;
    _els = {
        toggle: container.querySelector('.mm-toggle'),
        bar: container.querySelector('.mm-bar'),
        fillHeap: container.querySelector('.mm-fill-heap'),
        fillModels: container.querySelector('.mm-fill-models'),
        value: container.querySelector('.mm-value'),
        status: container.querySelector('.mm-status'),
        advice: container.querySelector('.mm-advice'),
        details: container.querySelector('.mm-details'),
    };
    _els.toggle.addEventListener('click', () => {
        _open = !_open;
        _els.toggle.setAttribute('aria-expanded', String(_open));
        _els.details.hidden = !_open;
        render();
    });

    onLifecycleEvent(() => render());
    onHeavyLoadChange(() => render());
    getCapabilities().then(render);
    tick();
    _timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => {
        // Don't burn cycles while hidden; resume immediately when shown.
        if (document.visibilityState === 'hidden') { clearInterval(_timer); _timer = null; }
        else if (!_timer) { tick(); _timer = setInterval(tick, POLL_MS); }
    });
}

export function initMemoryMonitor(selector = '#memoryMonitor') {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el || _root) return;
    mount(el);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initMemoryMonitor());
    } else {
        initMemoryMonitor();
    }
}
