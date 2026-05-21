// device-capabilities.js
// Probes the runtime environment so other modules can adapt: pick safer
// default models, warn before heavy loads, and avoid concurrent OOM crashes.
// Pure read-only — never throws; every probe degrades to a conservative value.

const _state = {
    ready: null,        // Promise<void>
    snapshot: null,     // resolved snapshot
    listeners: new Set(),
};

const DEFAULTS = {
    deviceMemoryGB: 4,    // navigator.deviceMemory often missing on iOS Safari
    cores: 4,
    isMobile: false,
    isIosSafari: false,
    webgpu: { supported: false, adapterInfo: null, maxBufferSizeMB: 0, maxStorageBufferBindingSizeMB: 0 },
    storageQuotaGB: null,
    connection: null,
};

function detectIosSafari() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(ua);
    return isIos && isSafari;
}

function detectMobile() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /Mobi|Android|iPad|iPhone|iPod/.test(ua);
}

async function probeWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        return { supported: false, adapterInfo: null, maxBufferSizeMB: 0, maxStorageBufferBindingSizeMB: 0 };
    }
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { supported: false, adapterInfo: null, maxBufferSizeMB: 0, maxStorageBufferBindingSizeMB: 0 };
        const limits = adapter.limits || {};
        let info = null;
        try {
            info = adapter.info ?? (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : null);
        } catch { /* ignore */ }
        return {
            supported: true,
            adapterInfo: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device } : null,
            maxBufferSizeMB: Math.round((limits.maxBufferSize ?? 0) / (1024 * 1024)),
            maxStorageBufferBindingSizeMB: Math.round((limits.maxStorageBufferBindingSize ?? 0) / (1024 * 1024)),
        };
    } catch {
        return { supported: false, adapterInfo: null, maxBufferSizeMB: 0, maxStorageBufferBindingSizeMB: 0 };
    }
}

async function probeStorageQuota() {
    try {
        if (navigator.storage && typeof navigator.storage.estimate === 'function') {
            const est = await navigator.storage.estimate();
            return est.quota ? est.quota / (1024 ** 3) : null;
        }
    } catch { /* ignore */ }
    return null;
}

async function buildSnapshot() {
    const snapshot = {
        ...DEFAULTS,
        deviceMemoryGB: navigator.deviceMemory || DEFAULTS.deviceMemoryGB,
        cores: navigator.hardwareConcurrency || DEFAULTS.cores,
        isMobile: detectMobile(),
        isIosSafari: detectIosSafari(),
        connection: navigator.connection ? {
            effectiveType: navigator.connection.effectiveType,
            saveData: !!navigator.connection.saveData,
            downlink: navigator.connection.downlink,
        } : null,
    };
    snapshot.webgpu = await probeWebGPU();
    snapshot.storageQuotaGB = await probeStorageQuota();
    return snapshot;
}

export function getCapabilities() {
    if (!_state.ready) {
        _state.ready = buildSnapshot().then((snap) => {
            _state.snapshot = snap;
            _state.listeners.forEach(fn => { try { fn(snap); } catch (e) { console.warn(e); } });
            return snap;
        });
    }
    return _state.ready;
}

export function getCapabilitiesSync() {
    return _state.snapshot;
}

export function onCapabilities(fn) {
    if (_state.snapshot) fn(_state.snapshot);
    _state.listeners.add(fn);
    return () => _state.listeners.delete(fn);
}

// ── Risk-tier helpers ──────────────────────────────────────────────────────────
// Heuristic ceilings, in MB, for "safely loadable" model weights based on
// device class. These are intentionally conservative — better to warn
// unnecessarily than crash the tab.
export function safeModelCeilingMB(snap = _state.snapshot) {
    if (!snap) return 1500;
    if (snap.isIosSafari) return 700;
    if (snap.isMobile) return 1500;
    if (!snap.webgpu.supported) return 800;     // CPU-only fallback
    // WebGPU adapter buffer caps are a hard ceiling for a single tensor.
    const buf = snap.webgpu.maxBufferSizeMB;
    const mem = snap.deviceMemoryGB * 1024;
    return Math.max(1500, Math.min(buf > 0 ? buf : 4096, mem * 0.6));
}

export function classifyModelRisk(modelSizeMB, snap = _state.snapshot) {
    const ceiling = safeModelCeilingMB(snap);
    if (modelSizeMB <= 0) return 'unknown';
    if (modelSizeMB > ceiling * 1.2) return 'critical';
    if (modelSizeMB > ceiling * 0.8) return 'high';
    if (modelSizeMB > ceiling * 0.4) return 'medium';
    return 'low';
}

// Recommend a safe default model id for a given task, given an ordered list
// of candidate {id, sizeMB} options sorted from smallest to largest. Returns
// the largest candidate that still classifies as 'low' or 'medium' risk.
// If snapshot is not yet ready (probe still in flight) returns null so
// callers fall back to their hardcoded default.
export function recommendDefault(candidates, snap = _state.snapshot) {
    if (!snap || !Array.isArray(candidates) || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => (a.sizeMB || 0) - (b.sizeMB || 0));
    let best = sorted[0].id;
    for (const c of sorted) {
        const risk = classifyModelRisk(c.sizeMB || 0, snap);
        if (risk === 'low' || risk === 'medium') best = c.id;
        else break;
    }
    return best;
}

// Kick off probe immediately so callers usually find a snapshot ready.
getCapabilities();
