// Medical Data Anonymization — composable detector + LLM pipeline
// NER / detectors: GLiNER, token-classification PII, mBERT, privacy filter
// LLM: Qwen3.5 (WebLLM/WebGPU) for PII detection and verification
// Zero data leaves the browser — all processing is local
//
// Model libraries are loaded lazily via dynamic import() when
// anonymization features are actually used, to avoid downloading
// large models at page load.

import {
    getActiveNERLoadLabel,
    DEFAULT_NER_MODEL_ID,
    NER_MODEL_OPTIONS,
    disposeNERPipeline,
    getActiveNERModelId,
    getActiveNERModelOption,
    getNERModelOption,
    getNERPipeline,
    initNERPipeline,
    isGLiNERModel,
    getGLiNERInstance,
    mapNEREntityType,
} from './privacy-runtime.js?v=2026-08-31-arena-fix-1';
import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-08-31-simple-download-1';
import { SYSTEM_PROMPT } from './anonymize-prompts.js?v=2026-09-10-review-1';
import {
    chunkText,
    DEFAULT_MAX_CHUNK_CHARS,
    LOW_MEMORY_MAX_CHUNK_CHARS,
    DEFAULT_CHUNK_OVERLAP_CHARS,
    LOW_MEMORY_CHUNK_OVERLAP_CHARS,
} from './text-chunking.js?v=2026-09-10-bench-1';
import { createDetectionKey, isObviousGarbage, filterLLMEntities, normalizeForMatch } from './anonymize-filters.js?v=2026-09-10-bench-1';
import { parseEntityArray, streamEntityExtraction } from './llm-extract.js?v=2026-09-10-bench-1';
import { PUBLISHED_BENCHMARK } from './benchmark-published.js?v=2026-09-10-bench-1';
import {
    classifyModelRisk,
    describeMemoryCeiling,
    getCapabilities,
    getCapabilitiesSync,
    getRuntimeMemorySnapshot,
} from './device-capabilities.js?v=2026-05-28-resource-1';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';

const DEFAULT_MODEL = 'Qwen3.5-2B-q4f16_1-MLC';
const DEFAULT_ANON_NER_MODEL_ID = 'openai_privacy_filter';
const FALLBACK_ANON_NER_MODEL_ID = 'multilang_pii';

// Qwen3.5 only: same memory class and runtime as Qwen3 but far better PII recall
// (Benchmark tab, 2026-08-30: 2B 83% vs Qwen3 1.7B 52%). Qwen3.5-0.8B is omitted
// here because it returns an empty list with the extraction prompt.
const LLM_MODEL_OPTIONS = {
    'Qwen3.5-2B-q4f16_1-MLC': {
        label: 'Qwen3.5 2B',
        size: '~2.2 GB',
        sizeMB: 2250,
        note: 'Compact model for identifier extraction. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3.5-4B-q4f16_1-MLC': {
        label: 'Qwen3.5 4B',
        size: '~3.9 GB',
        sizeMB: 3870,
        note: 'Largest browser-feasible option; needs ~4 GB GPU memory. Requires WebGPU.',
        engine: 'webllm',
    },
};

const WEBLLM_CACHE_MATCHERS = ['webllm', 'mlc', 'tvmjs'];

// Verbose detector/LLM logging prints document content (entities, raw model
// output) to the console. Off by default so identifiers never land in
// DevTools logs or screenshots; enable with ?anon-debug=1.
const ANON_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('anon-debug');
const debugLog = (...args) => { if (ANON_DEBUG) console.log(...args); };
const debugWarn = (...args) => { if (ANON_DEBUG) console.warn(...args); };

// ── State ──────────────────────────────────────────────────────────────────────
let engine = null;       // WebLLM engine
let loadedModelId = null;
let isNerLoading = false;
let currentMapping = { version: 1, entities: {}, counters: {} };
let anonDocument = null;
let anonDocType = null;
let anonWorkbook = null;
let anonymizedResult = null;
// Holds the *original* extracted text for non-Excel docs so we can re-apply
// `anonymizeText()` instantly whenever the user edits the mapping (add/remove).
let anonSourceText = null;
let manualEntities = new Set();
let isAnonModelLoading = false;
let isAnonymizing = false;
let lastDetectionBreakdown = { pipeline: 'llm', ner: [], llm: [], llmAdded: [] };
let detectionSeen = {
    ner: new Set(),
    llm: new Set(),
    llmAdded: new Set(),
    llmFiltered: new Set(),
};

// ── Review state (mapping table ↔ preview) ─────────────────────────────────
let previewMode = 'anonymized';     // 'anonymized' | 'original'
let previewSpans = [];              // non-overlapping entity occurrences in anonSourceText
let previewOccurrences = new Map(); // entity → [index into previewSpans, …]
let activeEntity = null;            // entity currently highlighted in table + preview
let occurrenceCursor = new Map();   // entity → occurrence index last shown by jumpToEntity
const unfoldedEntities = new Set(); // entities whose occurrence list is open in the table
let anonExcelRunConfig = null;      // { sheetName, selectedCols } captured when an Excel run starts
let showSelectionPopover = null;    // set by setupSelectionPopover(); used by jumpToRawText()
// Undo stack of mapping snapshots (one per user edit) so a mis-click never
// silently drops a real identifier before download.
const undoStack = [];
const MAX_UNDO = 50;
const PREVIEW_MAX_CHARS = 1_000_000;

// ── DOM Elements ───────────────────────────────────────────────────────────────
const anonDocUpload = document.getElementById('anonDocUpload');
const anonDocInput = document.getElementById('anonDocInput');
const anonDocInfo = document.getElementById('anonDocInfo');
const anonDocName = document.getElementById('anonDocName');
const anonMappingUpload = document.getElementById('anonMappingUpload');
const anonMappingInput = document.getElementById('anonMappingInput');
const anonMappingInfo = document.getElementById('anonMappingInfo');
const anonMappingName = document.getElementById('anonMappingName');
const anonExcelSettings = document.getElementById('anonExcelSettings');
const anonSheetSelect = document.getElementById('anonSheetSelect');
const anonColumnCheckboxes = document.getElementById('anonColumnCheckboxes');
const anonModelStatus = document.getElementById('anonModelStatus');
const anonModelProgress = document.getElementById('anonModelProgress');
const anonModelStatusText = document.getElementById('anonModelStatusText');
const anonProgress = document.getElementById('anonProgress');
const anonProgressBar = document.getElementById('anonProgressBar');
const anonProgressText = document.getElementById('anonProgressText');
const anonymizeBtn = document.getElementById('anonymizeBtn');
const anonResults = document.getElementById('anonResults');
const mappingTableBody = document.querySelector('#mappingTable tbody');
const nerDetectionTableBody = document.querySelector('#nerDetectionTable tbody');
const llmDetectionTableBody = document.querySelector('#llmDetectionTable tbody');
const llmAddedTableBody = document.querySelector('#llmAddedTable tbody');
const nerFilteredTableBody = document.querySelector('#nerFilteredTable tbody');
const nerFilteredSection = document.getElementById('nerFilteredSection');
const anonDetectionSummary = document.getElementById('anonDetectionSummary');
const llmAddedSection = document.getElementById('llmAddedSection');
const anonPreviewText = document.getElementById('anonPreviewText');
const anonPreviewMeta = document.getElementById('anonPreviewMeta');
const mappingAddEntity = document.getElementById('mappingAddEntity');
const mappingAddType = document.getElementById('mappingAddType');
const mappingAddReplacement = document.getElementById('mappingAddReplacement');
const mappingAddBtn = document.getElementById('mappingAddBtn');
const mappingUndoBtn = document.getElementById('mappingUndoBtn');
const llmFilteredTableBody = document.querySelector('#llmFilteredTable tbody');
const llmFilteredSection = document.getElementById('llmFilteredSection');
const llmFilteredCount = document.getElementById('llmFilteredCount');
const anonPreviewModeButtons = document.querySelectorAll('[data-preview-mode]');
const anonEntityPopover = document.getElementById('anonEntityPopover');
const mappingReplacementList = document.getElementById('mappingReplacementList');
const downloadAnonDocBtn = document.getElementById('downloadAnonDocBtn');
const downloadMappingBtn = document.getElementById('downloadMappingBtn');
const anonWebGPUStatus = document.getElementById('anonWebGPUStatus');
const anonModeTitle = document.getElementById('anonModeTitle');
const anonModeSubtitle = document.getElementById('anonModeSubtitle');
const anonMappingCount = document.getElementById('anonMappingCount');
const clearAnonMappingBtn = document.getElementById('clearAnonMappingBtn');
const anonModelSelect = document.getElementById('anonModelSelect');
const anonPipelineSelect = document.getElementById('anonPipelineSelect');
const anonNerModelSelect = document.getElementById('anonNerModelSelect');
const anonNerModelHint = document.getElementById('anonNerModelHint');
const anonPipelineSummary = document.getElementById('anonPipelineSummary');
const anonModelGrid = document.getElementById('anonModelGrid');
const anonNerModelCards = document.getElementById('anonNerModelCards');
const anonLlmModelCards = document.getElementById('anonLlmModelCards');
const anonModelSelectionError = document.getElementById('anonModelSelectionError');
const glinerThresholdRow = document.getElementById('glinerThresholdRow');
const glinerThresholdInput = document.getElementById('glinerThreshold');
const glinerThresholdValue = document.getElementById('glinerThresholdValue');
const mappingExportFormat = document.getElementById('mappingExportFormat');
const anonPdfFormat = document.getElementById('anonPdfFormat');
const anonResourceStatus = document.getElementById('anonResourceStatus');
const anonResourceInfoBtn = document.getElementById('anonResourceInfoBtn');
const anonResourceInfo = document.getElementById('anonResourceInfo');

// ── Persisted preferences (anonymize tab) ──────────────────────────────────
// Saved in localStorage so the user's model picks survive page reloads.
const LS_KEY_PIPELINE = 'medmorf.anon.pipeline';
const LS_KEY_NER_MODEL = 'medmorf.anon.nerModel';
const LS_KEY_LLM_MODEL = 'medmorf.anon.llmModel';
function loadStoredPref(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {}
}

const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');

function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// ── WebGPU Detection ───────────────────────────────────────────────────────────
let hasWebGPU = false;
let resourceMonitorTimer = null;
let activeResourceStage = { label: 'Idle', modelMB: 0, detail: 'No model running' };
(async function checkWebGPU() {
    if (anonWebGPUStatus) {
        if (navigator.gpu) {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter) {
                    hasWebGPU = true;
                    anonWebGPUStatus.innerHTML = '✓ WebGPU available';
                    anonWebGPUStatus.className = 'webgpu-status supported';
                } else {
                    anonWebGPUStatus.innerHTML = '⚠ No WebGPU adapter — using CPU NER';
                    anonWebGPUStatus.className = 'webgpu-status fallback';
                }
            } catch {
                anonWebGPUStatus.innerHTML = '⚠ WebGPU error — using CPU NER';
                anonWebGPUStatus.className = 'webgpu-status fallback';
            }
        } else {
            anonWebGPUStatus.innerHTML = '⚠ No WebGPU — using CPU NER';
            anonWebGPUStatus.className = 'webgpu-status fallback';
        }
    }
    initializeAnonymizeControls();
})();

function getDefaultCombinationFeasibility(snap = getCapabilitiesSync()) {
    const nerOption = getNERModelOption(DEFAULT_ANON_NER_MODEL_ID);
    const llmOption = LLM_MODEL_OPTIONS[DEFAULT_MODEL];
    const peakMB = Math.max(nerOption?.sizeMB || 0, llmOption?.sizeMB || 0);
    const webgpuSupported = snap ? !!snap.webgpu?.supported : hasWebGPU;
    if (!webgpuSupported) {
        return {
            feasible: false,
            reason: 'OpenAI Privacy Filter and Qwen require WebGPU.',
            peakMB,
            ceilingMB: 0,
        };
    }

    const ceiling = describeMemoryCeiling(snap || getCapabilitiesSync());
    const ceilingMB = ceiling.safeModelCeilingMB || 0;
    const risk = classifyModelRisk(peakMB, snap || getCapabilitiesSync());
    const feasible = ceilingMB > 0 && peakMB <= ceilingMB && risk !== 'critical';
    return {
        feasible,
        reason: feasible
            ? 'OpenAI Privacy Filter + Qwen3.5 2B fits the current browser/device estimate.'
            : `OpenAI Privacy Filter + Qwen3.5 2B needs about ${fmtResourceSize(peakMB)}; safe ceiling is ${fmtResourceSize(ceilingMB)}.`,
        peakMB,
        ceilingMB,
        risk,
    };
}

function applyDefaultModelSelection({ snap = getCapabilitiesSync() } = {}) {
    const combo = getDefaultCombinationFeasibility(snap);
    if (combo.feasible) {
        setSelectedPipeline('ner+llm');
        if (anonNerModelSelect && anonNerModelSelect.dataset.userChanged !== '1') {
            anonNerModelSelect.value = DEFAULT_ANON_NER_MODEL_ID;
        }
        if (anonModelSelect && anonModelSelect.dataset.userChosen !== '1') {
            anonModelSelect.value = DEFAULT_MODEL;
        }
    } else {
        setSelectedPipeline('ner');
        if (anonNerModelSelect && anonNerModelSelect.dataset.userChanged !== '1') {
            anonNerModelSelect.value = FALLBACK_ANON_NER_MODEL_ID;
        }
    }
    if (anonPipelineSummary) {
        anonPipelineSummary.title = combo.reason;
    }
}

// Pick the default anonymization combination unless the user has saved an override.
function applySmartDefaults() {
    if (!anonPipelineSelect) return;
    if (anonPipelineSelect.dataset.userChanged === '1') {
        updatePipelineControls();
        if (typeof updateNerModelHint === 'function') updateNerModelHint();
        return; // respect user override
    }
    applyDefaultModelSelection();
    updatePipelineControls();
    if (typeof updateNerModelHint === 'function') updateNerModelHint();
}

// Friendly summary of the active detection method
function updateModeBanner() {
    if (!anonModeTitle || !anonModeSubtitle) return;
    const pipeline = getSelectedPipeline();
    if (pipeline === 'llm') {
        const opt = getSelectedLLMOption();
        anonModeTitle.textContent = `LLM detection · ${opt.label}`;
        anonModeSubtitle.textContent = hasWebGPU
            ? 'Best accuracy. Runs on your GPU.'
            : '⚠ Needs WebGPU — switch to NER under Advanced settings on this device.';
    } else if (pipeline === 'ner+llm') {
        const nerOpt = getNERModelOption(getSelectedNerModelId());
        const llmOpt = getSelectedLLMOption();
        anonModeTitle.textContent = `NER + LLM · ${nerOpt.label} + ${llmOpt.label}`;
        anonModeSubtitle.textContent = isOpenAIPrivacyHybrid(pipeline)
            ? 'Two-pass detection: OpenAI NER uses WebGPU, unloads, then Qwen verifies and adds.'
            : 'Two-pass detection: NER first, LLM verifies and adds.';
    } else {
        const nerOpt = getNERModelOption(getSelectedNerModelId());
        anonModeTitle.textContent = `NER detection · ${nerOpt.label}`;
        anonModeSubtitle.textContent = 'Fast, no GPU required.';
    }
    updateResourceStatus();
}

function fmtResourceSize(mb) {
    if (mb === null || mb === undefined || Number.isNaN(mb) || mb <= 0) return 'n/a';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Math.round(mb)} MB`;
}

function getSelectedPeakModelMB() {
    const pipeline = getSelectedPipeline();
    const nerSize = getNERModelOption(getSelectedNerModelId()).sizeMB || 0;
    const llmSize = getSelectedLLMOption().sizeMB || 0;
    if (pipeline === 'ner') return nerSize;
    if (pipeline === 'llm') return llmSize;
    // NER + LLM runs sequentially, so model peak is max(stage A, stage B),
    // not their sum. Document chunks and model runtime overhead still add to it.
    return Math.max(nerSize, llmSize);
}

function getPipelineMemoryNote() {
    const pipeline = getSelectedPipeline();
    if (isOpenAIPrivacyHybrid(pipeline)) {
        return 'OpenAI NER requires WebGPU for its quantized ops, then unloads before Qwen loads. Exact live tab RAM and total VRAM are not exposed by this browser.';
    }
    if (pipeline === 'ner+llm') {
        return 'NER and Qwen run sequentially and unload between stages. Exact live tab RAM and total VRAM are not exposed by this browser.';
    }
    return 'Live JS heap is shown only when the browser exposes it; WebGPU exposes buffer limits, not total VRAM.';
}

function setResourceStage(label, modelMB = 0, detail = '') {
    activeResourceStage = { label, modelMB, detail };
    updateResourceStatus();
}

function updateResourceStatus() {
    if (!anonResourceStatus) return;
    const snap = getCapabilitiesSync();
    if (!snap) {
        anonResourceStatus.innerHTML = '<span>Checking resource headroom...</span>';
        return;
    }

    const runtime = getRuntimeMemorySnapshot();
    const ceiling = describeMemoryCeiling(snap, runtime);
    const peakMB = getSelectedPeakModelMB();
    const risk = classifyModelRisk(peakMB, snap);
    const jsHeap = runtime.jsHeapSupported
        ? `${fmtResourceSize(runtime.jsHeapUsedMB)} / ${fmtResourceSize(runtime.jsHeapLimitMB)}`
        : 'hidden by browser';
    const gpu = snap.webgpu.supported
        ? `${snap.webgpu.adapterInfo?.vendor || 'WebGPU'} · buffer ${fmtResourceSize(snap.webgpu.maxBufferSizeMB)}`
        : 'not available';
    const headroom = peakMB > 0
        ? `${fmtResourceSize(Math.max(0, ceiling.safeModelCeilingMB - peakMB))}`
        : 'n/a';

    anonResourceStatus.dataset.risk = risk;
    anonResourceStatus.innerHTML = `
        <div class="resource-metric resource-active">
            <span class="resource-label">Active now</span>
            <span class="resource-value">${escapeHTML(activeResourceStage.label)} · ${fmtResourceSize(activeResourceStage.modelMB)}</span>
        </div>
        <div class="resource-metric resource-peak">
            <span class="resource-label">Selected peak</span>
            <span class="resource-value">${fmtResourceSize(peakMB)} · ${escapeHTML(risk)}</span>
        </div>
        <div class="resource-metric">
            <span class="resource-label">Safe ceiling</span>
            <span class="resource-value">${fmtResourceSize(ceiling.safeModelCeilingMB)} est.</span>
        </div>
        <div class="resource-metric">
            <span class="resource-label">JS heap</span>
            <span class="resource-value">${escapeHTML(jsHeap)}</span>
        </div>
        <div class="resource-metric">
            <span class="resource-label">GPU / CPU</span>
            <span class="resource-value">${escapeHTML(gpu)} · ${snap.cores} cores</span>
        </div>
        <div class="resource-note">
            Headroom: ${escapeHTML(headroom)}. Main visible bottleneck: ${escapeHTML(ceiling.bottleneck.label)} (${fmtResourceSize(ceiling.bottleneck.valueMB)}). ${escapeHTML(activeResourceStage.detail || getPipelineMemoryNote())}
        </div>
    `;
}

function startResourceMonitor() {
    updateResourceStatus();
    if (resourceMonitorTimer) return;
    resourceMonitorTimer = setInterval(updateResourceStatus, 1000);
}

function stopResourceMonitor() {
    if (!resourceMonitorTimer) return;
    clearInterval(resourceMonitorTimer);
    resourceMonitorTimer = null;
    updateResourceStatus();
}

function populateLLMModelSelect() {
    if (!anonModelSelect) return;
    anonModelSelect.innerHTML = '';
    // Honour any persisted user choice first; otherwise use the repo default.
    const stored = loadStoredPref(LS_KEY_LLM_MODEL);
    const desired = (stored && LLM_MODEL_OPTIONS[stored]) ? stored : DEFAULT_MODEL;
    for (const [id, opt] of Object.entries(LLM_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        el.textContent = `${opt.label} (${opt.size})`;
        if (id === desired) el.selected = true;
        anonModelSelect.appendChild(el);
    }
    if (stored) anonModelSelect.dataset.userChosen = '1';
}

function restoreStoredAnonPreferences() {
    const storedPipeline = loadStoredPref(LS_KEY_PIPELINE);
    if (storedPipeline && anonPipelineSelect) {
        const hasOpt = Array.from(anonPipelineSelect.options).some(o => o.value === storedPipeline);
        if (hasOpt) {
            anonPipelineSelect.value = storedPipeline;
            anonPipelineSelect.dataset.userChanged = '1';
        }
    }

    const storedNer = loadStoredPref(LS_KEY_NER_MODEL);
    if (storedNer && anonNerModelSelect) {
        const hasOpt = Array.from(anonNerModelSelect.options).some(o => o.value === storedNer);
        if (hasOpt) {
            anonNerModelSelect.value = storedNer;
            anonNerModelSelect.dataset.userChanged = '1';
        }
    }

    const storedLLM = loadStoredPref(LS_KEY_LLM_MODEL);
    if (storedLLM && anonModelSelect && LLM_MODEL_OPTIONS[storedLLM]) {
        anonModelSelect.value = storedLLM;
        anonModelSelect.dataset.userChanged = '1';
        anonModelSelect.dataset.userChosen = '1';
    }
}

function initializeAnonymizeControls() {
    populateLLMModelSelect();
    populateNerModelSelect();
    renderModelPicker();
    restoreStoredAnonPreferences();
    applySmartDefaults();
    updatePipelineControls();
    updateNerModelHint();
    updateModeBanner();
    updateMappingCount();
}

// Re-evaluate the default once the device probe completes (only if the user
// hasn't already changed it manually).
let _llmSelectAutoSet = false;
getCapabilities().then(() => {
    // Only re-pick a default if the user has NOT made a manual choice (either
    // this session or persisted from a previous one).
    if (anonModelSelect && !_llmSelectAutoSet && !anonModelSelect.dataset.userChosen) {
        populateLLMModelSelect();
        renderModelPicker();
        _llmSelectAutoSet = true;
        applySmartDefaults();
        updateModeBanner();
    }
    updateResourceStatus();
});
if (anonModelSelect) {
    anonModelSelect.addEventListener('change', () => {
        anonModelSelect.dataset.userChosen = '1';
    });
}

// ── Model Loading (WebLLM) ──────────────────────────────────────────────────
function getSelectedModel() {
    return anonModelSelect ? anonModelSelect.value : DEFAULT_MODEL;
}

function getSelectedLLMOption() {
    return LLM_MODEL_OPTIONS[getSelectedModel()] || LLM_MODEL_OPTIONS[DEFAULT_MODEL];
}

function isWebLLMCacheAddError(error) {
    const message = error?.message || String(error);
    return /Cache\.add\(\).*network error|Failed to execute 'add' on 'Cache'|Cache\.add\(\) encountered a network error/i.test(message);
}

async function requestPersistentModelStorage() {
    try {
        if (navigator.storage?.persist) {
            await navigator.storage.persist();
        }
    } catch { /* non-fatal */ }
}

async function getStorageEstimateMB() {
    try {
        if (!navigator.storage?.estimate) return null;
        const estimate = await navigator.storage.estimate();
        const quotaMB = estimate.quota ? estimate.quota / (1024 * 1024) : 0;
        const usageMB = estimate.usage ? estimate.usage / (1024 * 1024) : 0;
        return { quotaMB, usageMB, freeMB: Math.max(0, quotaMB - usageMB) };
    } catch {
        return null;
    }
}

async function warnIfStorageTight(modelOption) {
    const estimate = await getStorageEstimateMB();
    if (!estimate || !modelOption?.sizeMB) return;
    const neededMB = modelOption.sizeMB * 1.15;
    if (estimate.freeMB < neededMB) {
        console.warn('[ANON] Low browser storage headroom before WebLLM load', {
            freeMB: Math.round(estimate.freeMB),
            neededMB: Math.round(neededMB),
            model: modelOption.label,
        });
        anonModelStatusText.textContent =
            `Chrome storage headroom is low (${fmtResourceSize(estimate.freeMB)} free). ` +
            'Model caching may fail; clear old model caches in Storage if this stops.';
    }
}

async function clearPartialWebLLMCache() {
    const deleted = [];
    try {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
            const lower = name.toLowerCase();
            if (WEBLLM_CACHE_MATCHERS.some(matcher => lower.includes(matcher))) {
                await caches.delete(name);
                deleted.push(`cache:${name}`);
            }
        }
    } catch (err) {
        console.warn('[ANON] Could not clear WebLLM Cache API entries:', err);
    }

    try {
        if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            await Promise.all(dbs
                .filter(db => WEBLLM_CACHE_MATCHERS.some(matcher => (db.name || '').toLowerCase().includes(matcher)))
                .map(db => new Promise(resolve => {
                    const req = indexedDB.deleteDatabase(db.name);
                    req.onsuccess = () => { deleted.push(`idb:${db.name}`); resolve(); };
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                })));
        }
    } catch (err) {
        console.warn('[ANON] Could not clear WebLLM IndexedDB entries:', err);
    }

    console.log('[ANON] Cleared partial WebLLM cache before retry:', deleted);
    return deleted;
}

async function createWebLLMEngineWithRecovery(CreateMLCEngine, selectedModel, modelOption, progressCallback) {
    await requestPersistentModelStorage();
    await warnIfStorageTight(modelOption);

    try {
        return await CreateMLCEngine(selectedModel, { initProgressCallback: progressCallback });
    } catch (error) {
        if (!isWebLLMCacheAddError(error)) throw error;

        anonModelStatusText.textContent = 'Chrome cache failed halfway — clearing partial WebLLM cache and retrying once...';
        setResourceStage('Retrying LLM cache', modelOption.sizeMB || 0, 'Chrome failed while caching a model shard; partial WebLLM cache is being cleared before one retry.');
        await clearPartialWebLLMCache();
        await releaseMemoryBetweenStages(null);
        return await CreateMLCEngine(selectedModel, { initProgressCallback: progressCallback });
    }
}


// iPhone/iPad: WebKit kills a tab around ~1.5 GB while the smallest WebLLM
// model needs ~1.6 GB VRAM — loading is a guaranteed crash (confirmed on an
// iPhone 17 Pro). Block with an explanation instead of crashing.
function isIosDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
const IOS_LLM_BLOCK_MSG = 'Language-model features are not available on iPhone/iPad: the smallest model needs ~1.6 GB of memory while iOS limits a browser tab to about 1.5 GB, so loading would crash the page. On this device use the NER-only pipeline (works on CPU); for LLM-grade anonymization use a desktop browser.';

async function initAnonModel() {
    if (isIosDevice()) {
        throw new Error(IOS_LLM_BLOCK_MSG);
    }
    const selectedModel = getSelectedModel();
    if (engine && loadedModelId === selectedModel) return;
    if (isAnonModelLoading) return;

    // If switching models, dispose previous
    if (engine && loadedModelId !== selectedModel) {
        await disposeAnonModel();
    }

    const modelOption = getSelectedLLMOption();
    const modelLabel = modelOption.label;
    setResourceStage(`Loading ${modelLabel}`, modelOption.sizeMB || 0, 'Active now is a stage estimate; this browser does not expose total live RAM or VRAM.');

    const proceed = await preflightWarn({
        key: `llm:${selectedModel}`,
        title: 'Download anonymization model?',
        model: `${modelLabel} (${selectedModel})`,
        sizeMB: modelOption.sizeMB || 0,
        why: 'Large LLMs need WebGPU and several GB of RAM/VRAM. On low-RAM devices the tab may crash. Pick a smaller variant if unsure.',
    });
    if (!proceed) {
        throw new Error('Model load cancelled by user');
    }

    return withHeavyLoadLock(`LLM: ${modelLabel}`, async () => {
        isAnonModelLoading = true;

        anonModelStatus.style.display = 'block';
        anonModelProgress.style.width = '0%';

        const anonModelHeading = document.getElementById('anonModelHeading');
        if (anonModelHeading) anonModelHeading.textContent = `Loading ${modelLabel}...`;

        anonModelStatusText.textContent = `Initializing ${modelLabel}...`;
        updateStatus('loading', `Loading ${modelLabel}...`);

        try {
            if (modelOption.engine === 'webllm') {
                // Check if model is already cached (skip network probe when offline)
                let modelCached = false;
                try {
                    const cacheNames = await caches.keys();
                    modelCached = cacheNames.some(name => {
                        const lower = name.toLowerCase();
                        return lower.includes('webllm') || lower.includes('mlc') || lower.includes('tvmjs');
                    });
                } catch { /* ignore */ }

                if (!modelCached) {
                    // Not cached — verify we can reach HuggingFace before starting a large download
                    const configUrl = `https://huggingface.co/mlc-ai/${selectedModel}/resolve/main/mlc-chat-config.json`;
                    try {
                        const probe = await fetch(configUrl);
                        if (!probe.ok) {
                            throw new Error(`HuggingFace returned ${probe.status} for ${selectedModel}. Check your internet connection.`);
                        }
                    } catch (fetchErr) {
                        console.error('Pre-flight fetch failed:', fetchErr);
                        throw new Error(
                            `Cannot reach model files for ${modelLabel}. ` +
                            (fetchErr.message.includes('Failed to fetch') || fetchErr.message.includes('NetworkError') || fetchErr.message.includes('Load failed')
                                ? 'Check your internet connection and ensure nothing is blocking huggingface.co (ad-blockers, VPN, firewall).'
                                : fetchErr.message)
                        );
                    }
                } else {
                    console.log('[ANON] Model appears cached, skipping pre-flight fetch');
                }

                const { CreateMLCEngine } = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/lib/index.js');
                const progressCallback = (progress) => {
                    const text = progress.text || '';
                    const pctMatch = text.match(/(\d+(?:\.\d+)?)%/);
                    if (pctMatch) {
                        anonModelProgress.style.width = pctMatch[1] + '%';
                    }
                    anonModelStatusText.textContent = text || 'Loading...';
                    updateStatus('loading', text || 'Loading anonymization model...');
                };
                engine = await createWebLLMEngineWithRecovery(CreateMLCEngine, selectedModel, modelOption, progressCallback);
            }

            anonModelStatusText.textContent = 'Anonymization model loaded ✓';
            anonModelProgress.style.width = '100%';
            loadedModelId = selectedModel;
            registerLoadedModel('anon-llm', disposeAnonModel, { sizeMB: modelOption.sizeMB || 0 });
            updateStatus('idle', 'System Ready');
            setTimeout(() => { anonModelStatus.style.display = 'none'; }, 2000);
        } catch (error) {
            console.error('Anonymization model loading error:', error);
            const userMsg = formatAnonModelLoadError(error, modelLabel);
            anonModelStatusText.textContent = 'Error: ' + userMsg;
            updateStatus('idle', 'Model loading failed');
            engine = null;
            throw new Error(userMsg);
        } finally {
            isAnonModelLoading = false;
        }
    });
}

function formatAnonModelLoadError(error, modelLabel) {
    const message = error?.message || String(error);
    if (isWebLLMCacheAddError(error)) {
        return `${modelLabel} download/cache failed in Chrome while WebLLM was storing model files. Medmorf cleared partial WebLLM cache and retried once. If it still fails around the same point, one model shard is likely blocked/interrupted or Chrome storage is tight. Disable ad-block/VPN/firewall for huggingface.co and cdn.jsdelivr.net, clear LLM cache in Storage, and retry with the tab in foreground.`;
    }
    if (/quota|storage|persist/i.test(message)) {
        return `${modelLabel} could not be cached because browser storage looks full or unavailable. Free disk space or clear old model caches in Storage, then retry.`;
    }
    if (message.includes('Cannot fetch') || /Failed to fetch|NetworkError|Load failed/i.test(message)) {
        return `Model download failed. Check your internet connection and ensure nothing blocks huggingface.co or cdn.jsdelivr.net. Then clear LLM cache in Storage and retry.`;
    }
    return message;
}

async function disposeAnonModel() {
    if (!engine) {
        loadedModelId = null;
        return;
    }

    const oldEngine = engine;
    engine = null;
    loadedModelId = null;
    unregisterLoadedModel('anon-llm');

    if (typeof oldEngine.unload === 'function') {
        await oldEngine.unload();
    }
}

async function llmChat(messages, options = {}) {
    if (!engine) throw new Error('LLM engine not loaded');
    markModelUsed('anon-llm');

    const reply = await engine.chat.completions.create({
        messages,
        max_tokens: options.max_tokens || 2048,
        // Qwen3 / Qwen3.5 hybrid-thinking: skip the <think> block. Prompts already
        // forbid reasoning; without this, Qwen3.5 spends the whole token budget thinking.
        extra_body: { enable_thinking: false },
        temperature: options.temperature ?? 0,
    });
    return reply.choices[0].message.content || '';
}

function getSelectedNerModelId() {
    return anonNerModelSelect ? anonNerModelSelect.value : DEFAULT_ANON_NER_MODEL_ID;
}

function updateNerModelHint() {
    if (!anonNerModelHint) return;
    const option = getNERModelOption(getSelectedNerModelId());
    const supportedLanguages = option.supportedLanguages ? option.supportedLanguages.join(', ') : 'See model card';
    const qualityNote = option.qualityNote ? ` Quality note: ${option.qualityNote}` : '';
    anonNerModelHint.textContent = `${option.label}: ${option.description} Supported languages: ${supportedLanguages}. Categories: ${option.categoriesLabel}.${qualityNote}`;
    // Show threshold slider only for GLiNER models, and only when NER is part of the pipeline
    if (glinerThresholdRow) {
        const showThreshold = option.engine === 'gliner' && getSelectedPipeline() !== 'llm';
        glinerThresholdRow.style.display = showThreshold ? 'flex' : 'none';
    }
}

function populateNerModelSelect() {
    if (!anonNerModelSelect) return;
    anonNerModelSelect.innerHTML = '';
    Object.values(NER_MODEL_OPTIONS).forEach((option) => {
        const selectOption = document.createElement('option');
        selectOption.value = option.id;
        selectOption.textContent = option.label;
        if (option.id === DEFAULT_ANON_NER_MODEL_ID) {
            selectOption.selected = true;
        }
        anonNerModelSelect.appendChild(selectOption);
    });
    updateNerModelHint();
}

function isOpenAIPrivacyHybrid(pipeline = getSelectedPipeline()) {
    return pipeline === 'ner+llm' && getSelectedNerModelId() === 'openai_privacy_filter';
}

function shouldUseLowMemoryNERForHybrid() {
    // OpenAI Privacy Filter cannot use the WASM backend because ONNX Runtime
    // does not implement its GatherBlockQuantized op there. Keep this hook for
    // future NER models that support CPU/WASM low-memory mode.
    return false;
}

async function initNerModel({ executionMode = 'default' } = {}) {
    const selectedNerModelId = getSelectedNerModelId();
    const loadedNerModelId = getActiveNERModelId();
    const activeLoadLabel = getActiveNERLoadLabel() || '';
    if (getNERPipeline() && loadedNerModelId === selectedNerModelId) {
        if (executionMode !== 'low-memory' || activeLoadLabel.includes('low-memory')) return;
        await disposeNERPipeline();
    }
    if (isNerLoading) return;

    const nerOption = getNERModelOption(selectedNerModelId);
    setResourceStage(`Loading ${nerOption.label}`, nerOption.sizeMB || 0, isOpenAIPrivacyHybrid()
        ? 'OpenAI Privacy Filter needs WebGPU for quantized ops; it will unload before Qwen loads.'
        : 'Active now is a stage estimate; this browser may hide exact live memory.');
    const lowMemoryNote = executionMode === 'low-memory'
        ? ' This model is loaded in low-memory CPU/WASM mode where supported.'
        : '';
    if (selectedNerModelId === 'openai_privacy_filter' && !hasWebGPU) {
        throw new Error('OpenAI Privacy Filter requires WebGPU in this browser. Choose GLiNER, Multilingual PII NER, or another CPU-capable NER model on this device.');
    }
    const proceed = await preflightWarn({
        key: `ner:${selectedNerModelId}:${executionMode}`,
        title: 'Download privacy model?',
        model: `${nerOption.label} — ${nerOption.model}`,
        sizeMB: nerOption.sizeMB || 0,
        why: `This NER model runs locally for PII detection. ${nerOption.qualityNote || ''}${lowMemoryNote}`,
    });
    if (!proceed) {
        throw new Error('Model load cancelled by user');
    }

    return withHeavyLoadLock(`NER: ${nerOption.label}`, async () => {
        isNerLoading = true;
        anonModelStatus.style.display = 'block';
        anonModelProgress.style.width = '0%';

        const anonModelHeading = document.getElementById('anonModelHeading');
        if (anonModelHeading) anonModelHeading.textContent = `Loading ${nerOption.label}...`;
        anonModelStatusText.textContent = `Downloading ${nerOption.label}...`;
        updateStatus('loading', `Loading ${nerOption.label}...`);

        try {
            await initNERPipeline({
                modelId: selectedNerModelId,
                executionMode,
                progressCallback: (progress) => {
                    if (progress.status === 'progress' && progress.total > 0) {
                        const pct = Math.round((progress.loaded / progress.total) * 100);
                        anonModelProgress.style.width = pct + '%';
                        anonModelStatusText.textContent = `Downloading ${nerOption.label}: ${pct}%`;
                    }
                },
            });

            anonModelStatusText.textContent = `${nerOption.label} loaded ✓`;
            anonModelProgress.style.width = '100%';
            registerLoadedModel('ner', disposeNERPipeline, { sizeMB: nerOption.sizeMB || 0 });
            updateStatus('idle', `${nerOption.label} ready`);
            setTimeout(() => { anonModelStatus.style.display = 'none'; }, 1500);
        } catch (error) {
            console.error('NER model loading error:', error);
            let message = error.message || String(error);
            if (selectedNerModelId === 'openai_privacy_filter' && /GatherBlockQuantized|WASM|wasm/i.test(message)) {
                message = 'OpenAI Privacy Filter requires WebGPU for its quantized embedding op. WASM/CPU loading is not supported; choose a CPU-capable NER model if WebGPU fails.';
            }
            anonModelStatusText.textContent = 'NER error: ' + message;
            updateStatus('idle', 'NER model loading failed');
            throw new Error(message);
        } finally {
            isNerLoading = false;
        }
    });
}

async function extractEntitiesNER(text) {
    // GLiNER models use a separate extraction path
    if (isGLiNERModel()) {
        return extractEntitiesGLiNER(text);
    }

    const pipeline = getNERPipeline();
    if (!pipeline) {
        throw new Error('NER model is not loaded');
    }
    debugLog('[NER] Running chunk', {
        modelId: getActiveNERModelId(),
        load: getActiveNERLoadLabel(),
        length: text.length,
        preview: text.slice(0, 200),
    });
    const aggregated = await pipeline(text, {
        aggregation_strategy: 'simple',
        ignore_labels: ['O'],
    });

    debugLog('[NER] Aggregated output for chunk:', aggregated);
    console.log('[NER] Aggregated sample:', aggregated.slice(0, 5).map(item => ({
        entity_group: item.entity_group || item.entity,
        word: item.word,
        start: item.start,
        end: item.end,
        offsetText: Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start
            ? text.slice(item.start, item.end)
            : null,
        score: item.score,
    })));

    // Merge adjacent entities of the same type (fixes B-B fragmentation from some models)
    // Also merges adjacent entities whose mapped types match (e.g. GIVENNAME+SURNAME → both PERSON)
    const merged = [];
    for (const item of aggregated) {
        const rawEntity = String(item.entity_group || item.entity || '').replace(/^[BI]-/, '');
        const prev = merged.length > 0 ? merged[merged.length - 1] : null;
        const prevRaw = prev ? String(prev.entity_group || prev.entity || '').replace(/^[BI]-/, '') : '';
        const gap = prev && Number.isInteger(prev.end) && Number.isInteger(item.start) ? item.start - prev.end : Infinity;
        const sameRawType = rawEntity === prevRaw;
        const sameMappedType = prev && mapNEREntityType(rawEntity, getActiveNERModelId()) === mapNEREntityType(prevRaw, getActiveNERModelId());
        if (prev && (sameRawType || sameMappedType) && gap <= 1) {
            prev.end = item.end;
            prev.word = (prev.word || '') + (item.word || '');
            prev.score = Math.min(prev.score || 0, item.score || 0);
        } else {
            merged.push({ ...item });
        }
    }

    const entities = [];
    const seen = new Set();
    for (const item of merged) {
        const rawEntity = String(item.entity_group || item.entity || '');
        const rawType = rawEntity.replace(/^[BI]-/, '');
        const type = mapNEREntityType(rawType, getActiveNERModelId());
        const score = item.score || 0;
        const hasOffsets = Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start;
        const entityFromOffsets = hasOffsets ? text.slice(item.start, item.end).trim() : '';
        const entityFromWord = String(item.word || '')
            .replace(/[Ġ▁]/g, ' ')
            .replace(/##/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const offsetHasAlpha = /[\p{L}@]/u.test(entityFromOffsets);
        const wordHasAlpha = /[\p{L}@]/u.test(entityFromWord);
        const offsetLooksNumericOnly = /^[\d\s.,:/+-]+$/.test(entityFromOffsets);
        // Prefer offset-based text when available and not purely numeric
        const entity = (!entityFromWord)
            ? entityFromOffsets
            : (hasOffsets && offsetHasAlpha && !offsetLooksNumericOnly)
                ? entityFromOffsets
                : (offsetLooksNumericOnly && wordHasAlpha)
                    ? entityFromWord
                    : (!offsetHasAlpha && wordHasAlpha)
                        ? entityFromWord
                        : hasOffsets
                            ? entityFromOffsets
                            : entityFromWord;

        if (!entity || entity.length < 2 || !type || score <= 0.1) {
            continue;
        }

        const key = `${entity.toLowerCase()}::${type}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        entities.push({ entity, type });
    }

    debugLog('[NER] Mapped entities:', entities);
    return entities;
}

function getGlinerThreshold() {
    return glinerThresholdInput ? parseFloat(glinerThresholdInput.value) : 0.3;
}

async function extractEntitiesGLiNER(text) {
    const gliner = getGLiNERInstance();
    if (!gliner) {
        throw new Error('GLiNER model is not loaded');
    }
    const modelOption = getActiveNERModelOption();
    const threshold = getGlinerThreshold();
    console.log('[GLiNER] Running inference', {
        modelId: getActiveNERModelId(),
        labelsCount: modelOption.piiLabels.length,
        threshold,
        length: text.length,
        preview: text.slice(0, 200),
    });

    const results = await gliner.inference({
        texts: [text],
        entities: modelOption.piiLabels,
        flatNer: true,
        threshold,
    });

    debugLog('[GLiNER] Raw results:', results[0]);

    const entities = [];
    const seen = new Set();
    for (const item of (results[0] || [])) {
        const rawLabel = item.label || '';
        const type = mapNEREntityType(rawLabel, modelOption.id);
        const entity = (item.spanText || '').trim();
        if (!entity || entity.length < 2 || !type || (item.score || 0) <= 0.1) {
            continue;
        }
        // Pre-filter obvious garbage before it reaches the LLM
        if (isObviousGarbage(entity, type)) {
            debugLog(`[GLiNER] Pre-filtered garbage: "${entity}" → ${type}`);
            continue;
        }
        const key = `${entity.toLowerCase()}::${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push({ entity, type, score: item.score });
    }

    debugLog('[GLiNER] Mapped entities:', entities);
    return entities;
}


// SYSTEM_PROMPT lives in ./anonymize-prompts.js so tests/test-models.html scores the exact prompt the app uses.

// Focused prompt for hybrid mode: NER already found PERSON/LOCATION/ORGANIZATION,
// so the LLM focuses on the remaining PII types that NER cannot detect.
const SYSTEM_PROMPT_FOCUSED = `You are a medical data anonymization expert. A NER model has attempted initial PII detection but may have missed entities. Your task is to find ALL PII in the text, especially any the NER missed.

You MUST check for ALL of these entity types:
- PERSON: ALL person names — patients, doctors, family members, nurses, contacts, children. This is critical.
- LOCATION: ALL cities, towns, countries, regions — e.g. "Utrecht", "Maastricht", "Eindhoven"
- ORGANIZATION: ALL organizations — hospitals, clinics, insurance companies, employers, schools, practices
- DATE: Any dates (birth dates, visit dates, admission dates, year-only birth years) — e.g. "12 maart 1981", "5 februari 2026", "2012"
- PHONE: Phone numbers, fax numbers — e.g. "+31 6 12345678"
- EMAIL: Email addresses — e.g. "j.devries@example.nl"
- ADDRESS: Street names, house numbers, postal codes — e.g. "Kastanjelaan 58", "6221 BN", "Stationsstraat 12"
- ID_NUMBER: BSN/SSN, insurance numbers, medical record numbers, IBAN, driver license — e.g. "731245689", "NL91 ABNA 0417 1643 00"
- AGE: Specific ages mentioned

Rules:
1. Return ONLY a valid JSON array with "entity" and "type" fields.
2. "entity" must be the EXACT text as it appears in the input.
3. Do NOT include diagnoses, symptoms, medications, or generic medical terms.
4. No explanations, no markdown, no thinking. ONLY the JSON array.
5. If no PII found, return: []

Important example:
- In "Lucas de Vries (geboren 2012) en Emma de Vries (geboren 2015). Ze zitten op de basisschool De Horizon in Maastricht.", detect "Lucas de Vries" and "Emma de Vries" as PERSON, "2012" and "2015" as DATE, "De Horizon" as ORGANIZATION, and "Maastricht" as LOCATION.

Example: [{"entity":"Jan de Vries","type":"PERSON"},{"entity":"Amsterdam","type":"LOCATION"},{"entity":"12 maart 1981","type":"DATE"}]`;

const SYSTEM_PROMPT_VALIDATE = `You are a conservative medical privacy reviewer. A NER / detector model detected the entities listed below. Your task is ONLY to identify obvious false positives that contain NO personally identifiable information and should be removed.

An entity is a FALSE POSITIVE if:
- PERSON: Not an actual person name. E.g. "mijn huisarts", "mijn vrouw", "contactpersoon" are roles/descriptions, not names. Real names: "Jan de Vries", "Dr. Jansen".
- LOCATION: Not an actual place name. E.g. "noodgevallen", "vermoeidheid", "mij" are common words. Real places: "Utrecht", "Maastricht".
- ID_NUMBER: Not an actual identifier value. E.g. "Goedemiddag", "Ja", "Wat", "Dank u" are conversational words. Real IDs: "731245689", "NL91 ABNA 0417 1643 00".
- ORGANIZATION: Not an actual organization name. E.g. "het ziekenhuis" is generic. Real: "TechSolutions BV", "Amsterdam UMC".

Conservative keep rules:
- If the entity contains ANY real PII, do NOT remove it, even when the type is imperfect or the span is too broad.
- NEVER remove street addresses, house numbers, postal codes, or address-like combinations such as "Kastanjelaan 58, 6221 BN Maastricht".
- NEVER remove clinician/provider names or titled names such as "Dr. Anne Jansen", including broader spans like "Dr. Anne Jansen van Huisartsenpraktijk".
- NEVER remove hospitals, clinics, medical practices, insurers, schools, employers, or named organizations.
- When unsure, KEEP the entity by returning nothing for it.

Return ONLY a JSON array of the obvious FALSE POSITIVES to REMOVE. Each item needs "entity" (exact text) and "reason" (brief why).
If ALL entities are valid PII, return: []
No explanations outside the JSON. ONLY the JSON array.

Example: [{"entity":"mijn huisarts","reason":"role description, not a name"},{"entity":"noodgevallen","reason":"common word, not a location"}]`;

function hasStrongPiiSignal(entity, type = '') {
    const text = String(entity || '').trim();
    if (!text) return false;
    const lower = text.toLowerCase();

    if (type === 'EMAIL' || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return true;
    if (type === 'PHONE' || /(?:\+?\d[\d\s().-]{6,}\d)/.test(text)) return true;
    if (type === 'ID_NUMBER' && /\d/.test(text)) return true;
    if (type === 'DATE' && (/\d/.test(text) || /\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sep|okt|nov|dec)\b/i.test(text))) return true;
    if (type === 'AGE' && /\d/.test(text)) return true;

    const hasDutchPostcode = /\b\d{4}\s?[A-Z]{2}\b/i.test(text);
    const hasHouseNumber = /\b\d+[a-z]?\b/i.test(text);
    const hasStreetWord = /\b(straat|laan|weg|plein|gracht|dijk|kade|singel|hof|pad|boulevard|drive|road|street|avenue|lane)\b/i.test(text);
    if (type === 'ADDRESS' || hasDutchPostcode || (hasStreetWord && hasHouseNumber)) return true;

    const hasCareProviderTitle = /\b(dr\.?|dokter|huisarts|arts|psychiater|psycholoog|therapeut|verpleegkundige|specialist)\b/i.test(text);
    const hasMedicalOrganization = /\b(huisartsenpraktijk|praktijk|ziekenhuis|umc|kliniek|ggz|apotheek|medical center|clinic|hospital)\b/i.test(text);
    if (hasCareProviderTitle || hasMedicalOrganization) return true;

    const nameLike = /(?:^|\s)(?:[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ.'-]+)(?:\s+(?:de|den|der|van|van de|van der|ter|ten|op|aan|von|da|del|la))*\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ.'-]+/.test(text);
    if (type === 'PERSON' && nameLike) return true;
    if ((type === 'LOCATION' || type === 'ORGANIZATION') && /[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ.'-]{2,}/.test(text)) return true;

    return false;
}

async function validateEntitiesWithLLM(entities, text) {
    if (!entities.length || !engine) return entities;

    const entityList = entities.map(e => `- "${e.entity}" → ${e.type}`).join('\n');
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT_VALIDATE },
        { role: 'user', content: `Original text:\n${text}\n\nEntities detected by NER:\n${entityList}\n\nReturn ONLY the false positives to REMOVE as a JSON array.` },
    ];

    markModelUsed('anon-llm');
    const { raw: response, looped } = await streamEntityExtraction(engine, messages, { max_tokens: 2048, temperature: 0 });
    debugLog('[LLM Validate] Raw response:', response, looped ? '(loop interrupted)' : '');

    try {
        const { entities: rejects } = parseEntityArray(response);
        {
            debugLog('[LLM Validate] Entities to reject:', rejects);

            const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
            const entityByKey = new Map(entities.map(e => [normalize(e.entity), e]));
            const rejectSet = new Set();
            for (const r of rejects) {
                if (!r) continue;
                const txt = r.entity || r.text || r.value || r.name || '';
                if (typeof txt === 'string' && txt.trim()) {
                    const key = normalize(txt);
                    const original = entityByKey.get(key);
                    if (original && hasStrongPiiSignal(original.entity, original.type)) {
                        debugWarn('[LLM Validate] Keeping rejected entity because it still looks like PII:', original);
                        continue;
                    }
                    rejectSet.add(key);
                }
            }

            const kept = entities.filter(e => !rejectSet.has(normalize(e.entity)));
            const removed = entities.filter(e => rejectSet.has(normalize(e.entity)));

            console.log('[LLM Validate] Kept:', kept.length, 'Removed:', removed.length);
            if (removed.length > 0) {
                debugLog('[LLM Validate] Removed false positives:', removed);
                lastDetectionBreakdown.nerFiltered.push(...removed);
            }
            return kept;
        }
    } catch (e) {
        console.warn('[LLM Validate] Parse error, keeping all entities:', e?.message || e);
    }
    // On failure, keep all entities (safer for privacy)
    return entities;
}


function recordFilteredLLMEntities(dropped) {
    if (!dropped.length) return;
    if (!Array.isArray(lastDetectionBreakdown.llmFiltered)) lastDetectionBreakdown.llmFiltered = [];
    for (const item of dropped) {
        const key = createDetectionKey(item.entity, item.type);
        if (detectionSeen.llmFiltered.has(key)) continue;
        detectionSeen.llmFiltered.add(key);
        lastDetectionBreakdown.llmFiltered.push(item);
    }
    debugLog('[LLM] Dropped by sanity filters:', dropped);
}

async function extractEntitiesLLM(text, systemPrompt) {
    if (!engine) throw new Error('LLM engine not loaded');
    markModelUsed('anon-llm');
    const messages = [
        { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
        { role: 'user', content: `Extract all PII entities from this medical text:\n\n${text}` },
    ];
    // Streamed with a repetition guard: small Qwen models can loop on
    // dialogue-style text; the guard interrupts at the first repeated objects.
    // Whatever was complete when output stopped is kept by parseEntityArray.
    const { raw, looped } = await streamEntityExtraction(engine, messages, { max_tokens: 2048, temperature: 0 });
    const { entities: parsed, truncated } = parseEntityArray(raw);
    if (looped || truncated) console.warn(`[LLM] extraction ${looped ? 'loop interrupted' : 'output truncated'}; salvaged ${parsed.length} entities`);
    const { kept, dropped } = filterLLMEntities(parsed, text);
    recordFilteredLLMEntities(dropped);
    return kept;
}

// ── Mapping Management ─────────────────────────────────────────────────────────
function getOrCreateReplacement(entity, type) {
    const normalized = entity.trim();
    for (const [key, info] of Object.entries(currentMapping.entities)) {
        if (key.toLowerCase() === normalized.toLowerCase()) {
            return info.replacement;
        }
    }
    if (!currentMapping.counters[type]) currentMapping.counters[type] = 0;
    currentMapping.counters[type]++;
    const replacement = `[${type}_${currentMapping.counters[type]}]`;
    currentMapping.entities[normalized] = { type, replacement };
    return replacement;
}


function resetDetectionBreakdown(pipeline) {
    lastDetectionBreakdown = { pipeline, ner: [], llm: [], llmAdded: [], nerFiltered: [], llmFiltered: [] };
    detectionSeen = {
        ner: new Set(),
        llm: new Set(),
        llmAdded: new Set(),
        llmFiltered: new Set(),
    };
}

function recordDetectedEntities(source, entities) {
    const target = source === 'ner' ? lastDetectionBreakdown.ner : lastDetectionBreakdown.llm;
    const seenSet = source === 'ner' ? detectionSeen.ner : detectionSeen.llm;

    for (const { entity, type } of entities) {
        const key = createDetectionKey(entity, type);
        if (!seenSet.has(key)) {
            seenSet.add(key);
            target.push({ entity, type });
        }
        if (source === 'llm' && !detectionSeen.ner.has(key) && !detectionSeen.llmAdded.has(key)) {
            detectionSeen.llmAdded.add(key);
            lastDetectionBreakdown.llmAdded.push({ entity, type });
        }
    }
}

function renderDetectionTable(tableBody, entities, emptyMessage, { withReason = false } = {}) {
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (entities.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="${withReason ? 3 : 2}">${escapeHTML(emptyMessage)}</td>`;
        tableBody.appendChild(tr);
        return;
    }

    entities
        .slice()
        .sort((a, b) => a.type.localeCompare(b.type) || a.entity.localeCompare(b.entity))
        .forEach(({ entity, type, reason }) => {
            const tr = document.createElement('tr');
            tr.className = 'is-jumpable';
            tr.dataset.entity = entity;
            tr.title = 'Click to show in the preview';
            tr.innerHTML = `
                <td>${escapeHTML(entity)}</td>
                <td><span class="entity-tag entity-tag-${escapeHTML(String(type).toLowerCase())}">${escapeHTML(type)}</span></td>
                ${withReason ? `<td class="mapping-reason-cell">${escapeHTML(reason || '')}</td>` : ''}
            `;
            tableBody.appendChild(tr);
        });
}

// One compiled matcher per mapping entry: escaped literal, whitespace runs
// flexible (PDF/dictation text breaks names across spaces and newlines), and
// Unicode-aware word boundaries so substrings inside words are not replaced.
const entityRegexCache = new Map();
function getEntityRegex(entity) {
    let regex = entityRegexCache.get(entity);
    if (!regex) {
        const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const prefix = /[\p{L}\p{N}]/u.test(entity.charAt(0)) ? '(?<![\\p{L}\\p{N}])' : '';
        const suffix = /[\p{L}\p{N}]/u.test(entity.charAt(entity.length - 1)) ? '(?![\\p{L}\\p{N}])' : '';
        regex = new RegExp(prefix + escaped + suffix, 'giu');
        entityRegexCache.set(entity, regex);
    }
    regex.lastIndex = 0;
    return regex;
}

// Every non-overlapping entity occurrence in `text`, sorted by position.
// Longer entities claim their characters first (same precedence as the old
// sequential replace), so "Pieter de Vries" wins over "Pieter". Working on
// spans instead of successive string replaces also means a short numeric
// entity can never match inside an already-inserted [TAG_1].
// With `includeDisabled`, entities the user switched off are matched too —
// but only in characters no enabled entity claimed, and flagged `disabled`
// so the preview can show them greyed out. anonymizeText() never uses them.
function isEntityEnabled(info) {
    return !!info && info.disabled !== true;
}

function computeEntitySpans(text, { includeDisabled = false } = {}) {
    const spans = [];
    if (typeof text !== 'string' || !text) return spans;
    const byLength = (a, b) => b[0].length - a[0].length;
    const all = Object.entries(currentMapping.entities)
        .filter(([entity, info]) => entity && info && info.replacement);
    const entries = all.filter(([, info]) => isEntityEnabled(info)).sort(byLength);
    if (includeDisabled) entries.push(...all.filter(([, info]) => !isEntityEnabled(info)).sort(byLength));
    const taken = new Uint8Array(text.length);
    for (const [entity, info] of entries) {
        const regex = getEntityRegex(entity);
        let m;
        while ((m = regex.exec(text)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            if (end === start) { regex.lastIndex++; continue; }
            let free = true;
            for (let i = start; i < end; i++) {
                if (taken[i]) { free = false; break; }
            }
            if (!free) continue;
            taken.fill(1, start, end);
            spans.push({ start, end, entity, type: info.type, replacement: info.replacement, disabled: !isEntityEnabled(info) });
        }
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
}

function anonymizeText(text) {
    if (typeof text !== 'string' || !text) return text;
    const spans = computeEntitySpans(text);
    if (spans.length === 0) return text;
    let out = '';
    let cursor = 0;
    for (const s of spans) {
        out += text.slice(cursor, s.start) + s.replacement;
        cursor = s.end;
    }
    return out + text.slice(cursor);
}

function loadMappingFromJSON(jsonString) {
    const data = JSON.parse(jsonString);
    currentMapping = {
        version: data.version || 1,
        entities: data.entities || {},
        counters: data.counters || {},
    };
    rebuildCounters();
    updateMappingCount();
}

function loadMappingFromXLSX(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) return;

    // Expected columns: Entity | Type | Replacement
    const headers = rows[0].map(h => String(h).toLowerCase().trim());
    const entityCol = headers.findIndex(h => h.includes('entity') || h.includes('original'));
    const typeCol = headers.findIndex(h => h.includes('type'));
    const replacementCol = headers.findIndex(h => h.includes('replacement') || h.includes('replace'));

    if (entityCol === -1 || typeCol === -1) {
        throw new Error('Mapping XLSX must have "Entity" and "Type" columns. Optional: "Replacement".');
    }

    currentMapping = { version: 1, entities: {}, counters: {} };
    for (let i = 1; i < rows.length; i++) {
        const entity = String(rows[i][entityCol] || '').trim();
        const type = String(rows[i][typeCol] || '').trim().toUpperCase();
        if (!entity || !type) continue;

        let replacement = replacementCol !== -1 ? String(rows[i][replacementCol] || '').trim() : '';
        if (!replacement) {
            if (!currentMapping.counters[type]) currentMapping.counters[type] = 0;
            currentMapping.counters[type]++;
            replacement = `[${type}_${currentMapping.counters[type]}]`;
        }
        currentMapping.entities[entity] = { type, replacement };
    }
    rebuildCounters();
    updateMappingCount();
}

function rebuildCounters() {
    if (Object.keys(currentMapping.counters).length === 0) {
        for (const info of Object.values(currentMapping.entities)) {
            const match = info.replacement.match(/_(\d+)\]$/);
            if (match) {
                const num = parseInt(match[1]);
                currentMapping.counters[info.type] = Math.max(currentMapping.counters[info.type] || 0, num);
            }
        }
    }
}

function updateMappingCount() {
    if (anonMappingCount) {
        const count = Object.keys(currentMapping.entities).length;
        anonMappingCount.textContent = count > 0 ? `${count} entities loaded` : 'No mapping loaded';
    }
}


function getChunkSizeForPipeline(pipeline) {
    return isOpenAIPrivacyHybrid(pipeline) ? LOW_MEMORY_MAX_CHUNK_CHARS : DEFAULT_MAX_CHUNK_CHARS;
}

function getChunkOverlapForPipeline(pipeline) {
    return isOpenAIPrivacyHybrid(pipeline) ? LOW_MEMORY_CHUNK_OVERLAP_CHARS : DEFAULT_CHUNK_OVERLAP_CHARS;
}

async function yieldBetweenChunks() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

// ── Document Extraction ────────────────────────────────────────────────────────
let _pdfjsLib = null;
async function loadPdfJs() {
    if (_pdfjsLib) return _pdfjsLib;
    const PDFJS_VERSION = '4.7.76';
    const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`);
    if (lib.GlobalWorkerOptions) {
        lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
    }
    _pdfjsLib = lib;
    return lib;
}

async function extractTextFromPdf(file) {
    const pdfjs = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    let pdf;
    try {
        pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    } catch (error) {
        throw createPdfReadError(error);
    }
    const pageTexts = [];
    try {
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            try {
                const content = await page.getTextContent();
                // Reconstruct text with line breaks based on item.hasEOL or absent newlines
                let pageText = '';
                let lastY = null;
                for (const item of content.items) {
                    const text = item.str || '';
                    const y = item.transform ? item.transform[5] : null;
                    if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) {
                        pageText += '\n';
                    } else if (pageText && !pageText.endsWith(' ') && text && !text.startsWith(' ')) {
                        pageText += ' ';
                    }
                    pageText += text;
                    if (item.hasEOL) pageText += '\n';
                    lastY = y;
                }
                pageTexts.push(pageText.trim());
            } finally {
                page.cleanup?.();
            }
        }
        return pageTexts.join('\n\n');
    } finally {
        await pdf.destroy?.();
    }
}

function isPdfReadError(error) {
    return error?.code === 'MEDMORF_PDF_READ_ERROR' ||
        /InvalidPDFException|PasswordException|MissingPDFException|UnexpectedResponseException/i.test(error?.name || '') ||
        /Invalid PDF structure|password|encrypted|PDF/i.test(error?.message || '');
}

function createPdfReadError(error) {
    const originalMessage = error?.message || String(error);
    let message = 'This PDF could not be read. The file appears to have an invalid or unsupported PDF structure.';
    if (/password|encrypted|PasswordException/i.test(`${error?.name || ''} ${originalMessage}`)) {
        message = 'This PDF is password-protected or encrypted, so Medmorf cannot read it in the browser.';
    }
    const wrapped = new Error(`${message} Try opening the file and exporting it again as a new PDF, or use Print > Save as PDF, then upload the new copy.`);
    wrapped.name = 'PDFReadError';
    wrapped.code = 'MEDMORF_PDF_READ_ERROR';
    wrapped.cause = error;
    return wrapped;
}

function formatAnonymizationError(error) {
    if (isPdfReadError(error)) {
        return error.message || 'This PDF could not be read. Try exporting it again as a new PDF and upload the new copy.';
    }
    return error?.message || String(error);
}

// Build a new PDF containing the anonymized plain text using pdf-lib.
// (Re-rendering as a new document strips original metadata and embedded images,
//  which is the safer outcome for an anonymization tool.)
async function createAnonymizedPdfBlob(text) {
    if (typeof PDFLib === 'undefined') {
        throw new Error('pdf-lib not loaded');
    }
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontSize = 11;
    const lineHeight = fontSize * 1.4;
    const pageWidth = 595.28;   // A4 in points
    const pageHeight = 841.89;
    const margin = 56;
    const maxWidth = pageWidth - margin * 2;

    // Word-wrap helper
    function wrapLine(line) {
        if (line === '') return [''];
        const words = line.split(/(\s+)/);
        const lines = [];
        let current = '';
        for (const word of words) {
            const candidate = current + word;
            const width = font.widthOfTextAtSize(candidate, fontSize);
            if (width > maxWidth && current.trim().length > 0) {
                lines.push(current);
                current = word.replace(/^\s+/, '');
            } else {
                current = candidate;
            }
        }
        if (current.length > 0) lines.push(current);
        return lines;
    }

    // pdf-lib's WinAnsi font can't render some Unicode chars; substitute safely.
    const safeText = text.replace(/[^\x00-\xFF]/g, '?');

    const sourceLines = safeText.split(/\r?\n/);
    const wrapped = [];
    for (const line of sourceLines) {
        for (const w of wrapLine(line)) wrapped.push(w);
    }

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    for (const line of wrapped) {
        if (y < margin) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
        y -= lineHeight;
    }

    const bytes = await doc.save();
    return new Blob([bytes], { type: 'application/pdf' });
}

async function extractTextFromDocument(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    if (extension === 'txt') {
        return await file.text();
    } else if (extension === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value;
    } else if (extension === 'pdf') {
        return await extractTextFromPdf(file);
    } else if (extension === 'xlsx') {
        const data = await file.arrayBuffer();
        anonWorkbook = XLSX.read(data, { type: 'array' });
        return null;
    }
    throw new Error('Unsupported file type: ' + extension);
}

// ── Excel Helpers ──────────────────────────────────────────────────────────────
function getSelectedAnonColumns() {
    const checkboxes = anonColumnCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.value));
}

function loadAnonSheetColumns(sheetName) {
    const worksheet = anonWorkbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    if (jsonData.length === 0) {
        anonColumnCheckboxes.innerHTML = '<p>No data found</p>';
        return;
    }
    const headers = jsonData[0];
    anonColumnCheckboxes.innerHTML = '';
    headers.forEach((header, index) => {
        const div = document.createElement('div');
        div.className = 'checkbox-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `anon-col-${index}`;
        checkbox.value = index;
        checkbox.checked = typeof header === 'string';
        const label = document.createElement('label');
        label.htmlFor = `anon-col-${index}`;
        label.textContent = header || `Column ${index + 1}`;
        div.appendChild(checkbox);
        div.appendChild(label);
        anonColumnCheckboxes.appendChild(div);
        checkbox.addEventListener('change', updateAnonBtnState);
    });
    updateAnonBtnState();
}

function updateAnonBtnState() {
    if (anonDocType === 'excel') {
        anonymizeBtn.disabled = getSelectedAnonColumns().length === 0;
    }
}

// ── Pipeline Selection ─────────────────────────────────────────────────────────
function pipelineUsesNer(pipeline = getSelectedPipeline()) {
    return pipeline === 'ner' || pipeline === 'ner+llm';
}

function pipelineUsesLlm(pipeline = getSelectedPipeline()) {
    return pipeline === 'llm' || pipeline === 'ner+llm';
}

function getPipelineLabel(pipeline = getSelectedPipeline()) {
    if (pipeline === 'ner+llm') return 'NER + LLM';
    if (pipeline === 'ner') return 'NER only';
    return 'LLM only';
}

function getSelectedPipeline() {
    return anonPipelineSelect ? anonPipelineSelect.value : 'llm';
}

function setSelectedPipeline(pipeline, { persist = false, userChanged = false } = {}) {
    if (!anonPipelineSelect) return;
    if (!['llm', 'ner', 'ner+llm'].includes(pipeline)) return;
    anonPipelineSelect.value = pipeline;
    if (userChanged) anonPipelineSelect.dataset.userChanged = '1';
    if (persist) savePref(LS_KEY_PIPELINE, pipeline);
}

function showModelSelectionError(message = '') {
    if (!anonModelSelectionError) return;
    anonModelSelectionError.textContent = message;
    anonModelSelectionError.style.display = message ? 'block' : 'none';
}

function createModelCard(family, option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'anon-model-card';
    button.dataset.modelFamily = family;
    button.dataset.modelId = option.id;
    button.setAttribute('aria-pressed', 'false');

    const meta = family === 'ner'
        ? fmtResourceSize(option.sizeMB || 0)
        : option.size || fmtResourceSize(option.sizeMB || 0);
    const detail = family === 'ner'
        ? (option.qualityNote || option.description || '')
        : (option.note || '');
    const status = document.createElement('span');
    status.className = 'anon-model-card-status';
    status.textContent = 'Off';

    button.innerHTML = `
        <span class="anon-model-card-main">
            <span class="anon-model-card-title">${escapeHTML(option.label)}</span>
            <span class="anon-model-card-meta">${escapeHTML(meta)}</span>
        </span>
        <span class="anon-model-card-detail">${escapeHTML(detail)}</span>
    `;
    button.appendChild(status);
    return button;
}

// ── Published benchmark numbers (src/benchmark-published.js, generated) ──────
// Results are presented separately from model-selection controls.
const BENCH = PUBLISHED_BENCHMARK || null;
const benchPct = (r) => (r && r.status !== 'skipped' && r.status !== 'fail' && typeof r.recall === 'number') ? `${Math.round(r.recall * 100)}%` : '—';
function renderPublishedBenchNote() {
    const el = document.getElementById('anonBenchNote');
    if (!el) return;
    if (!BENCH?.models || !BENCH?.best) { el.hidden = true; return; }
    el.hidden = false;
    const sets = BENCH.sets || [];
    const best = (BENCH.unions || []).find(u => u.ner === BENCH.best.ner && u.llm === BENCH.best.llm);
    const label = s => s.label.split(' (')[0].replace(/ — .*$/, '');
    const rows = [
        ...(BENCH.unions || []).map(u => ({ label: u.label, kind: 'Detector + LLM', results: u.results, best: u === best })),
        ...Object.values(BENCH.models).map(m => ({ ...m, kind: m.kind === 'ner' ? 'Detector only' : 'LLM only' }))
    ];
    rows.sort((a, b) => Number(Boolean(b.best)) - Number(Boolean(a.best)));
    el.innerHTML = `
        <div class="anon-bench-heading"><div><span class="anon-bench-kicker">Measured performance</span><h3 id="anonBenchTitle">How many identifiers were found?</h3></div><span class="anon-bench-date">${escapeHTML(BENCH.date)}</span></div>
        <p class="anon-bench-intro"><strong>Recall</strong> is the share of real identifiers detected. Higher is better. A score of 90% means roughly 10 in every 100 identifiers were missed.</p>
        ${best ? `<div class="anon-bench-best"><span class="anon-bench-kicker">Best measured combination</span><h4>${escapeHTML(BENCH.best.label)}</h4><dl class="anon-bench-scores">${sets.map(s => `<div><dt>${escapeHTML(label(s))}</dt><dd>${benchPct(best.results?.[s.key])}<span>recall</span></dd><small>${s.docs} document${s.docs === 1 ? '' : 's'} · ${s.items} identifiers</small></div>`).join('')}</dl></div>` : ''}
        <div class="anon-bench-table-wrap" role="region" aria-label="Anonymization recall comparison" tabindex="0"><table class="anon-bench-table"><caption>Recall by model and dataset</caption><thead><tr><th scope="col">Model / combination</th>${sets.map(s => `<th scope="col">${escapeHTML(label(s))}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr${r.best ? ' class="is-best"' : ''}><th scope="row">${escapeHTML(r.label)}<small>${escapeHTML(r.kind)}${r.best ? ' · Best measured' : ''}</small></th>${sets.map(s => `<td>${benchPct(r.results?.[s.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="anon-bench-review"><strong>Review is still required.</strong> These are synthetic test results, not a guarantee of anonymization. Missed identifiers and combinations of personal details can still identify someone.</p>
        <p class="anon-bench-source">— = not measured or unavailable. <a href="${escapeHTML(BENCH.reportFile)}" target="_blank" rel="noopener noreferrer">Full results, precision &amp; missed identifiers ↗</a><br>Source: <code>${escapeHTML(BENCH.sourceFile)}</code></p>`;
}

function renderModelPicker() {
    if (anonNerModelCards) {
        anonNerModelCards.innerHTML = '';
        Object.values(NER_MODEL_OPTIONS).forEach((option) => {
            anonNerModelCards.appendChild(createModelCard('ner', option));
        });
    }
    if (anonLlmModelCards) {
        anonLlmModelCards.innerHTML = '';
        Object.entries(LLM_MODEL_OPTIONS).forEach(([id, option]) => {
            anonLlmModelCards.appendChild(createModelCard('llm', { ...option, id }));
        });
    }
    renderPublishedBenchNote();
    syncModelPickerState();
}

function syncModelPickerState() {
    const pipeline = getSelectedPipeline();
    const nerActive = pipelineUsesNer(pipeline);
    const llmActive = pipelineUsesLlm(pipeline);
    const selectedNer = getSelectedNerModelId();
    const selectedLlm = getSelectedModel();

    if (anonModelGrid) {
        anonModelGrid.dataset.pipeline = pipeline;
        anonModelGrid.dataset.nerActive = String(nerActive);
        anonModelGrid.dataset.llmActive = String(llmActive);
    }

    document.querySelectorAll('.anon-model-family').forEach((panel) => {
        const family = panel.querySelector('.anon-model-card')?.dataset.modelFamily;
        panel.dataset.active = family === 'ner' ? String(nerActive) : String(llmActive);
    });

    document.querySelectorAll('.anon-model-card').forEach((card) => {
        const family = card.dataset.modelFamily;
        const selected = family === 'ner'
            ? card.dataset.modelId === selectedNer
            : card.dataset.modelId === selectedLlm;
        const active = family === 'ner' ? nerActive : llmActive;
        const isActiveSelection = selected && active;
        card.classList.toggle('is-selected', selected);
        card.classList.toggle('is-active', isActiveSelection);
        card.classList.toggle('is-off', selected && !active);
        card.setAttribute('aria-pressed', String(isActiveSelection));
        const status = card.querySelector('.anon-model-card-status');
        if (status) {
            status.textContent = isActiveSelection ? 'On' : selected ? 'Off' : 'Choose';
        }
    });

    if (anonPipelineSummary) {
        const parts = [];
        if (nerActive) parts.push(getNERModelOption(selectedNer).label);
        if (llmActive) parts.push(getSelectedLLMOption().label);
        anonPipelineSummary.textContent = `Active pipeline: ${getPipelineLabel(pipeline)} · ${parts.join(' + ')}`;
    }
}

function handleModelCardClick(card) {
    if (!card || isAnonymizing || isAnonModelLoading || isNerLoading) return;
    const family = card.dataset.modelFamily;
    const modelId = card.dataset.modelId;
    const pipeline = getSelectedPipeline();
    const nerActive = pipelineUsesNer(pipeline);
    const llmActive = pipelineUsesLlm(pipeline);
    const isNer = family === 'ner';
    const isSelected = isNer ? modelId === getSelectedNerModelId() : modelId === getSelectedModel();
    let nextNerActive = nerActive;
    let nextLlmActive = llmActive;

    showModelSelectionError('');

    if (isNer) {
        if (anonNerModelSelect) {
            anonNerModelSelect.value = modelId;
            anonNerModelSelect.dataset.userChanged = '1';
            savePref(LS_KEY_NER_MODEL, modelId);
        }
        nextNerActive = isSelected && nerActive ? false : true;
    } else {
        if (anonModelSelect) {
            anonModelSelect.value = modelId;
            anonModelSelect.dataset.userChanged = '1';
            anonModelSelect.dataset.userChosen = '1';
            savePref(LS_KEY_LLM_MODEL, modelId);
        }
        nextLlmActive = isSelected && llmActive ? false : true;
    }

    if (!nextNerActive && !nextLlmActive) {
        showModelSelectionError('Keep at least one model active.');
        nextNerActive = nerActive;
        nextLlmActive = llmActive;
    }

    const nextPipeline = nextNerActive && nextLlmActive
        ? 'ner+llm'
        : nextNerActive
            ? 'ner'
            : 'llm';
    setSelectedPipeline(nextPipeline, { persist: true, userChanged: true });
    updatePipelineControls();
    updateNerModelHint();
    updateModeBanner();
}

function updatePipelineControls() {
    const pipeline = getSelectedPipeline();
    const nerVisible = pipelineUsesNer(pipeline);
    if (anonNerModelHint) anonNerModelHint.style.display = nerVisible ? '' : 'none';
    if (glinerThresholdRow) {
        if (!nerVisible) {
            glinerThresholdRow.style.display = 'none';
        } else if (isGLiNERModel(getSelectedNerModelId())) {
            glinerThresholdRow.style.display = '';
        } else {
            glinerThresholdRow.style.display = 'none';
        }
    }
    syncModelPickerState();
}

function setModelPickerDisabled(disabled) {
    document.querySelectorAll('.anon-model-card').forEach((card) => {
        card.disabled = disabled;
    });
}

// ── Main Anonymization Flow ────────────────────────────────────────────────────
async function performAnonymization() {
    if (isAnonymizing || !anonDocument) return;
    isAnonymizing = true;
    anonymizeBtn.disabled = true;
    if (anonModelSelect) anonModelSelect.disabled = true;
    if (anonPipelineSelect) anonPipelineSelect.disabled = true;
    if (anonNerModelSelect) anonNerModelSelect.disabled = true;
    setModelPickerDisabled(true);
    anonResults.style.display = 'none';
    anonProgress.style.display = 'block';
    anonProgressBar.style.width = '0%';
    startResourceMonitor();

    const pipeline = getSelectedPipeline();
    let effectivePipeline = pipeline;
    let failureMessage = '';
    resetDetectionBreakdown(pipeline);
    resetReviewState();

    try {
        // Load models based on pipeline.
        // For ner+llm we deliberately load NER ONLY here. The LLM is loaded
        // mid-run AFTER the NER phase completes and the NER pipeline is
        // disposed, so we never hold both models resident at the same time
        // (loading both can exhaust GPU/RAM and crash the tab).
        if (pipeline === 'ner+llm') {
            anonProgressText.textContent = 'Loading NER model...';
            updateStatus('loading', 'Loading NER model...');
            setResourceStage('Loading NER', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, getPipelineMemoryNote());
            await initNerModel({ executionMode: 'default' });
        } else if (pipeline === 'ner') {
            anonProgressText.textContent = 'Loading NER model...';
            updateStatus('loading', 'Loading NER model...');
            setResourceStage('Loading NER', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, getPipelineMemoryNote());
            await initNerModel();
        } else {
            anonProgressText.textContent = 'Loading LLM model...';
            updateStatus('loading', 'Loading LLM model...');
            setResourceStage('Loading LLM', getSelectedLLMOption().sizeMB || 0, getPipelineMemoryNote());
            await initAnonModel();
        }

        if (anonDocType === 'excel') {
            effectivePipeline = await anonymizeExcel(effectivePipeline);
        } else {
            effectivePipeline = await anonymizeTextDocument(effectivePipeline);
        }

        // Reflect any LLM-load fallback in the rendered summary.
        if (lastDetectionBreakdown && effectivePipeline !== lastDetectionBreakdown.pipeline) {
            lastDetectionBreakdown.pipeline = effectivePipeline;
        }

        renderResults();
    } catch (error) {
        console.error('Anonymization error:', error);
        failureMessage = formatAnonymizationError(error);
        anonProgressBar.style.width = '100%';
        anonProgressText.textContent = 'Error: ' + failureMessage;
        updateStatus('idle', 'Anonymization failed');
        if (isPdfReadError(error)) {
            alert(failureMessage);
        }
    } finally {
        await releaseMemoryBetweenStages(async () => {
            await disposeNERPipeline();
            await disposeAnonModel();
        });
        isAnonymizing = false;
        anonymizeBtn.disabled = false;
        if (anonModelSelect) anonModelSelect.disabled = false;
        if (anonPipelineSelect) anonPipelineSelect.disabled = false;
        if (anonNerModelSelect) anonNerModelSelect.disabled = false;
        setModelPickerDisabled(false);
        updatePipelineControls();
        anonProgress.style.display = failureMessage ? 'block' : 'none';
        setResourceStage('Idle', 0, 'No model running');
        stopResourceMonitor();
        updateStatus('idle', 'System Ready');
    }
}

async function anonymizeTextDocument(pipeline) {
    const text = await extractTextFromDocument(anonDocument);
    anonSourceText = text;
    const chunks = chunkText(text, getChunkSizeForPipeline(pipeline), getChunkOverlapForPipeline(pipeline));
    const totalChunks = chunks.length;

    updateStatus('translating', 'Extracting PII entities...');

    if (pipeline === 'ner+llm') {
        // Phase 1: NER pass (NER model resident, LLM not loaded yet).
        anonProgressText.textContent = 'NER pass: extracting entities...';
        setResourceStage('NER pass', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, 'NER model resident. Per-chunk text is processed and released between chunks where possible.');
        const nerChunkResults = [];
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            nerChunkResults.push(nerEntities);
            await yieldBetweenChunks();
        }

        // Free NER memory BEFORE loading the LLM. Holding both resident at
        // the same time can crash the tab (the LLM alone needs ~3 GB on q4).
        anonProgressText.textContent = 'Releasing NER model memory...';
        setResourceStage('Releasing NER', 0, 'NER model is being unloaded before the LLM stage.');
        await releaseMemoryBetweenStages(disposeNERPipeline);

        // Now load the LLM. If it fails, we still have NER results in memory
        // and can degrade gracefully to NER-only output.
        anonProgressText.textContent = 'Loading LLM model...';
        updateStatus('loading', 'Loading LLM model...');
        setResourceStage('Loading LLM', getSelectedLLMOption().sizeMB || 0, 'Qwen is loading after the NER model was released.');
        try {
            await initAnonModel();
        } catch (llmError) {
            console.warn('LLM model failed to load, falling back to NER-only:', llmError.message);
            anonProgressText.textContent = 'LLM unavailable — using NER results only...';
            for (const nerEntities of nerChunkResults) {
                recordDetectedEntities('ner', nerEntities);
                for (const { entity, type } of nerEntities) {
                    getOrCreateReplacement(entity, type);
                }
            }
            nerChunkResults.length = 0;
            anonProgressText.textContent = 'Applying anonymization...';
            anonProgressBar.style.width = '90%';
            anonymizedResult = anonymizeText(text);
            anonProgressBar.style.width = '100%';
            anonProgressText.textContent = 'Anonymization complete (NER only) ✓';
            return 'ner';
        }

        // Phase 2: LLM validation — filter NER false positives
        anonProgressText.textContent = 'LLM validation: filtering false positives...';
        setResourceStage('LLM validation', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. JS heap may stay hidden, so this is a stage estimate.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = 20 + Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM validation: chunk ${i + 1}/${totalChunks}`;
            const validated = await validateEntitiesWithLLM(nerChunkResults[i], chunks[i]);
            recordDetectedEntities('ner', validated);
            for (const { entity, type } of validated) {
                getOrCreateReplacement(entity, type);
            }
            nerChunkResults[i] = null;
            await yieldBetweenChunks();
        }

        // Phase 3: LLM discovery — find additional PII the NER missed
        anonProgressText.textContent = 'LLM pass: finding remaining PII...';
        setResourceStage('LLM discovery', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. Chunks are cleared after processing.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = 40 + Math.round(((i + 1) / totalChunks) * 35);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
            const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', llmEntities);
            for (const { entity, type } of llmEntities) {
                getOrCreateReplacement(entity, type);
            }
            chunks[i] = '';
            await yieldBetweenChunks();
        }
    } else if (pipeline === 'ner') {
        anonProgressText.textContent = 'NER pass: extracting entities...';
        setResourceStage('NER pass', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, 'NER model resident. Chunks are cleared after processing.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            recordDetectedEntities('ner', nerEntities);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
            chunks[i] = '';
            await yieldBetweenChunks();
        }
    } else {
        // LLM-only mode
        anonProgressText.textContent = 'Extracting entities...';
        setResourceStage('LLM pass', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. JS heap may stay hidden, so this is a stage estimate.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `Extracting entities: chunk ${i + 1}/${totalChunks}`;
            const entities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', entities);
            for (const { entity, type } of entities) {
                getOrCreateReplacement(entity, type);
            }
            chunks[i] = '';
            await yieldBetweenChunks();
        }
    }

    anonProgressText.textContent = 'Releasing model memory...';
    setResourceStage('Releasing model', 0, 'Loaded model is being unloaded; browser memory release may lag briefly.');
    await releaseMemoryBetweenStages(async () => {
        await disposeNERPipeline();
        await disposeAnonModel();
    });

    anonProgressText.textContent = 'Applying anonymization...';
    setResourceStage('Applying mapping', 0, 'No model should be resident; applying replacements to the extracted text.');
    anonProgressBar.style.width = '90%';
    anonymizedResult = anonymizeText(text);
    anonProgressBar.style.width = '100%';
    anonProgressText.textContent = 'Anonymization complete ✓';
    return pipeline;
}

// Best-effort memory release between heavy model stages. Calls the supplied
// dispose function, then yields to the event loop and triggers GC where
// available so the next big allocation has room to land.
async function releaseMemoryBetweenStages(disposeFn) {
    try {
        if (typeof disposeFn === 'function') await disposeFn();
    } catch (err) {
        console.warn('[anon] dispose failed:', err);
    }
    // Two macrotasks + a microtask drain gives WebGPU/WASM time to actually
    // release device memory before we ask for the next chunk.
    await new Promise(r => setTimeout(r, 150));
    if (typeof globalThis.gc === 'function') {
        try { globalThis.gc(); } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 150));
}

async function anonymizeExcel(pipeline) {
    const sheetName = anonSheetSelect.value;
    const worksheet = anonWorkbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const selectedCols = getSelectedAnonColumns();

    const textCells = [];
    const dataRows = jsonData.slice(1);
    for (const row of dataRows) {
        for (const colIdx of selectedCols) {
            const val = row[colIdx];
            if (val && typeof val === 'string' && val.trim()) {
                textCells.push(val);
            }
        }
    }

    const allText = textCells.join('\n---\n');
    // Keep the joined cell text so the review panel can quote each entity and
    // mapping edits can be re-applied to the workbook without the models.
    anonSourceText = allText;
    anonExcelRunConfig = { sheetName, selectedCols: [...selectedCols] };
    const chunks = chunkText(allText, getChunkSizeForPipeline(pipeline), getChunkOverlapForPipeline(pipeline));
    const totalChunks = chunks.length;

    updateStatus('translating', 'Extracting PII entities...');

    if (pipeline === 'ner+llm') {
        // Phase 1: NER pass.
        anonProgressText.textContent = 'NER pass: extracting entities...';
        setResourceStage('NER pass', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, 'NER model resident. Excel text is chunked before detection.');
        const nerChunkResults = [];
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            nerChunkResults.push(nerEntities);
            await yieldBetweenChunks();
        }

        // Free NER memory before bringing the LLM online.
        anonProgressText.textContent = 'Releasing NER model memory...';
        setResourceStage('Releasing NER', 0, 'NER model is being unloaded before the LLM stage.');
        await releaseMemoryBetweenStages(disposeNERPipeline);

        anonProgressText.textContent = 'Loading LLM model...';
        updateStatus('loading', 'Loading LLM model...');
        setResourceStage('Loading LLM', getSelectedLLMOption().sizeMB || 0, 'Qwen is loading after the NER model was released.');
        let llmAvailable = true;
        try {
            await initAnonModel();
        } catch (llmError) {
            console.warn('LLM model failed to load, falling back to NER-only:', llmError.message);
            anonProgressText.textContent = 'LLM unavailable — using NER results only...';
            llmAvailable = false;
            for (const nerEntities of nerChunkResults) {
                recordDetectedEntities('ner', nerEntities);
                for (const { entity, type } of nerEntities) {
                    getOrCreateReplacement(entity, type);
                }
            }
            nerChunkResults.length = 0;
            pipeline = 'ner';
        }

        if (llmAvailable) {
            anonProgressText.textContent = 'LLM validation: filtering false positives...';
            setResourceStage('LLM validation', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. JS heap may stay hidden, so this is a stage estimate.');
            for (let i = 0; i < totalChunks; i++) {
                const pct = 20 + Math.round(((i + 1) / totalChunks) * 20);
                anonProgressBar.style.width = pct + '%';
                anonProgressText.textContent = `LLM validation: chunk ${i + 1}/${totalChunks}`;
                const validated = await validateEntitiesWithLLM(nerChunkResults[i], chunks[i]);
                recordDetectedEntities('ner', validated);
                for (const { entity, type } of validated) {
                    getOrCreateReplacement(entity, type);
                }
                nerChunkResults[i] = null;
                await yieldBetweenChunks();
            }

            anonProgressText.textContent = 'LLM pass: finding remaining PII...';
            setResourceStage('LLM discovery', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. Chunks are cleared after processing.');
            for (let i = 0; i < totalChunks; i++) {
                const pct = 40 + Math.round(((i + 1) / totalChunks) * 35);
                anonProgressBar.style.width = pct + '%';
                anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
                const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
                recordDetectedEntities('llm', llmEntities);
                for (const { entity, type } of llmEntities) {
                    getOrCreateReplacement(entity, type);
                }
                chunks[i] = '';
                await yieldBetweenChunks();
            }
        }
    } else if (pipeline === 'ner') {
        anonProgressText.textContent = 'NER pass: extracting entities...';
        setResourceStage('NER pass', getNERModelOption(getSelectedNerModelId()).sizeMB || 0, 'NER model resident. Chunks are cleared after processing.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            recordDetectedEntities('ner', nerEntities);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
            chunks[i] = '';
            await yieldBetweenChunks();
        }
    } else {
        anonProgressText.textContent = 'Extracting entities...';
        setResourceStage('LLM pass', getSelectedLLMOption().sizeMB || 0, 'Qwen is resident. JS heap may stay hidden, so this is a stage estimate.');
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `Extracting entities: chunk ${i + 1}/${totalChunks}`;
            const entities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', entities);
            for (const { entity, type } of entities) {
                getOrCreateReplacement(entity, type);
            }
            chunks[i] = '';
            await yieldBetweenChunks();
        }
    }

    anonProgressText.textContent = 'Releasing model memory...';
    setResourceStage('Releasing model', 0, 'Loaded model is being unloaded; browser memory release may lag briefly.');
    await releaseMemoryBetweenStages(async () => {
        await disposeNERPipeline();
        await disposeAnonModel();
    });

    anonProgressText.textContent = 'Applying anonymization...';
    setResourceStage('Applying mapping', 0, 'No model should be resident; applying replacements to workbook cells.');
    anonProgressBar.style.width = '90%';

    anonymizedResult = applyMappingToWorkbook();
    anonProgressBar.style.width = '100%';
    anonProgressText.textContent = 'Anonymization complete ✓';
    return pipeline;
}

// Apply the current mapping to the sheet/columns captured at run start. Pure
// string work — no model needed — so mapping edits (remove, merge, undo) can
// rebuild the workbook instantly before download.
function applyMappingToWorkbook() {
    if (!anonWorkbook || !anonExcelRunConfig) return anonymizedResult;
    const { sheetName, selectedCols } = anonExcelRunConfig;
    const worksheet = anonWorkbook.Sheets[sheetName];
    if (!worksheet) return anonymizedResult;
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const newData = [jsonData[0] || []];
    for (const row of jsonData.slice(1)) {
        const newRow = [...row];
        for (const colIdx of selectedCols) {
            if (newRow[colIdx] && typeof newRow[colIdx] === 'string') {
                newRow[colIdx] = anonymizeText(newRow[colIdx]);
            }
        }
        newData.push(newRow);
    }
    const newWorksheet = XLSX.utils.aoa_to_sheet(newData);
    const newWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, sheetName);
    anonWorkbook.SheetNames.forEach(sn => {
        if (sn !== sheetName) XLSX.utils.book_append_sheet(newWorkbook, anonWorkbook.Sheets[sn], sn);
    });
    return newWorkbook;
}

// ── Results Rendering ──────────────────────────────────────────────────────────
function renderResults() {
    anonResults.style.display = 'block';

    if (anonDetectionSummary) {
        const activeNerOption = getNERModelOption(getSelectedNerModelId());
        const activeLoadLabel = getActiveNERLoadLabel();
        const nerModelLabel = activeLoadLabel
            ? `${activeNerOption.label} (${activeLoadLabel})`
            : activeNerOption.label;
        const llmModelLabel = getSelectedLLMOption().label;
        const filteredNote = lastDetectionBreakdown.nerFiltered.length > 0
            ? ` LLM filtered ${lastDetectionBreakdown.nerFiltered.length} NER false positives.`
            : '';
        if (lastDetectionBreakdown.pipeline === 'llm') {
            anonDetectionSummary.textContent = `LLM only used. Active LLM model: ${llmModelLabel}. LLM found ${lastDetectionBreakdown.llm.length} unique entities.`;
        } else if (lastDetectionBreakdown.pipeline === 'ner') {
            anonDetectionSummary.textContent = `NER only used. Active NER / detector model: ${nerModelLabel}. NER found ${lastDetectionBreakdown.ner.length} unique entities.`;
        } else {
            anonDetectionSummary.textContent = `NER + LLM used. Active models: ${nerModelLabel} + ${llmModelLabel}. NER found ${lastDetectionBreakdown.ner.length} unique entities.${filteredNote} LLM found ${lastDetectionBreakdown.llm.length} unique entities. LLM added ${lastDetectionBreakdown.llmAdded.length} entities beyond NER.`;
        }
    }
    renderDetectionTable(nerDetectionTableBody, lastDetectionBreakdown.ner, 'No NER detections for this run.');
    renderDetectionTable(llmDetectionTableBody, lastDetectionBreakdown.llm, 'No LLM detections for this run.');
    renderDetectionTable(llmAddedTableBody, lastDetectionBreakdown.llmAdded, 'No extra LLM-only detections for this run.');
    renderDetectionTable(nerFilteredTableBody, lastDetectionBreakdown.nerFiltered, 'No false positives filtered.');
    const llmFiltered = Array.isArray(lastDetectionBreakdown.llmFiltered) ? lastDetectionBreakdown.llmFiltered : [];
    renderDetectionTable(llmFilteredTableBody, llmFiltered, 'Nothing dropped.', { withReason: true });
    if (llmAddedSection) {
        llmAddedSection.style.display = lastDetectionBreakdown.pipeline === 'ner+llm' ? 'block' : 'none';
    }
    if (nerFilteredSection) {
        nerFilteredSection.style.display = (lastDetectionBreakdown.pipeline === 'ner+llm' && lastDetectionBreakdown.nerFiltered.length > 0) ? 'block' : 'none';
    }
    if (llmFilteredSection) {
        llmFilteredSection.style.display = llmFiltered.length > 0 ? 'block' : 'none';
        if (llmFilteredCount) llmFilteredCount.textContent = llmFiltered.length ? `(${llmFiltered.length})` : '';
    }

    // Occurrence index drives the quotes, counts, click-to-jump and the preview.
    rebuildPreviewIndex();

    mappingTableBody.innerHTML = '';
    const entries = Object.entries(currentMapping.entities).sort((a, b) => a[1].type.localeCompare(b[1].type));
    for (const [entity, info] of entries) {
        const tr = document.createElement('tr');
        const isManual = manualEntities.has(entity);
        const enabled = isEntityEnabled(info);
        tr.className = `${isManual ? 'is-manual' : ''}${entity === activeEntity ? ' is-active' : ''}${enabled ? '' : ' is-disabled'}`.trim();
        tr.dataset.entity = entity;
        const src = entitySourceLabel(entity, info);
        tr.innerHTML = `
            <td class="mapping-toggle-cell"><input type="checkbox" class="mapping-toggle" data-entity="${escapeHTML(entity)}" ${enabled ? 'checked' : ''} title="${enabled ? 'On: replaced in the output. Untick to keep the original text.' : 'Off: kept as-is in the output. Tick to replace it.'}" aria-label="Apply ${escapeHTML(entity)}"></td>
            <td class="mapping-original-cell" data-entity="${escapeHTML(entity)}">${renderOriginalCellHTML(entity)}</td>
            <td><span class="entity-tag entity-tag-${escapeHTML(String(info.type).toLowerCase())}">${escapeHTML(info.type)}</span>${src ? `<span class="mapping-src mapping-src-${src.toLowerCase()}" title="Detected by ${src}">${src}</span>` : ''}</td>
            <td class="mapping-replacement-cell" data-entity="${escapeHTML(entity)}" title="Click to edit. Set to an existing tag (e.g. [PERSON_1]) to merge."><code>${escapeHTML(info.replacement)}</code></td>
            <td><button type="button" class="mapping-delete-btn" data-entity="${escapeHTML(entity)}" title="Delete from the list (Undo restores it)">✕</button></td>
        `;
        mappingTableBody.appendChild(tr);
    }

    // Refresh autocomplete + popover alias picker with the unique replacements
    refreshReplacementChoices();

    renderPreview();
    updateUndoButton();
    updateMappingCount();
}

// ── Review helpers: quotes, occurrence index, highlighted preview ──────────────
function rebuildPreviewIndex() {
    previewSpans = typeof anonSourceText === 'string' ? computeEntitySpans(anonSourceText, { includeDisabled: true }) : [];
    previewOccurrences = new Map();
    previewSpans.forEach((span, i) => {
        let list = previewOccurrences.get(span.entity);
        if (!list) { list = []; previewOccurrences.set(span.entity, list); }
        list.push(i);
    });
}

// Short context window around one occurrence, snapped to word boundaries and
// with whitespace collapsed so it fits on one table line.
function buildQuote(text, start, end, radius = 56) {
    let from = Math.max(0, start - radius);
    let to = Math.min(text.length, end + radius);
    if (from > 0) {
        const ws = text.slice(from, start).search(/\s/);
        if (ws >= 0 && ws < 20) from += ws + 1;
    }
    if (to < text.length) {
        const tail = text.slice(end, to);
        const m = tail.match(/\s\S*$/);
        if (m && m.index > tail.length - 20) to = end + m.index;
    }
    const collapse = (str) => str.replace(/\s+/g, ' ');
    return {
        before: collapse(text.slice(from, start)),
        hit: collapse(text.slice(start, end)),
        after: collapse(text.slice(end, to)),
        beforeTruncated: from > 0,
        afterTruncated: to < text.length,
    };
}

// Which detector produced an entity (for targeting the review at LLM-only
// additions). Manual = added by the user in this session.
function entitySourceLabel(entity, info) {
    if (manualEntities.has(entity)) return 'manual';
    const key = createDetectionKey(entity, info.type);
    const inNer = detectionSeen.ner.has(key);
    const inLlm = detectionSeen.llm.has(key);
    if (inNer && inLlm) return 'NER+LLM';
    if (inNer) return 'NER';
    if (inLlm) return 'LLM';
    return '';
}

function quoteHTML(span) {
    const q = buildQuote(anonSourceText, span.start, span.end);
    return `${q.beforeTruncated ? '…' : ''}${escapeHTML(q.before)}<mark>${escapeHTML(q.hit)}</mark>${escapeHTML(q.after)}${q.afterTruncated ? '…' : ''}`;
}

function renderOriginalCellHTML(entity) {
    const idxs = previewOccurrences.get(entity) || [];
    const hasText = typeof anonSourceText === 'string';
    const unfolded = unfoldedEntities.has(entity) && idxs.length > 0;
    let badge = '';
    if (hasText && idxs.length === 0) {
        badge = '<span class="mapping-occ mapping-occ-missing" title="This text does not occur in the document: it will not replace anything. Usually a paraphrase or a model false positive. Safe to switch off or delete.">not in text</span>';
    } else if (idxs.length > 0) {
        const k = occurrenceCursor.has(entity) ? occurrenceCursor.get(entity) : -1;
        const label = k >= 0 ? `${k + 1}/${idxs.length}` : `${idxs.length}×`;
        badge = `<span class="mapping-occ" title="Occurrences in the document">${label}</span>`;
    }
    const showBtn = (hasText && idxs.length > 0)
        ? `<button type="button" class="mapping-show-btn" data-entity="${escapeHTML(entity)}" aria-expanded="${unfolded ? 'true' : 'false'}" title="Jump to it in the preview and ${unfolded ? 'fold' : 'unfold'} every occurrence with context">${unfolded ? 'Hide context ▴' : 'Show in text ▾'}</button>`
        : '';
    let body = '';
    if (hasText && idxs.length > 0) {
        if (unfolded) {
            const k = occurrenceCursor.get(entity) ?? -1;
            body = `<ol class="mapping-occ-list">${idxs.map((spanIndex, i) => `<li><button type="button" class="mapping-occ-item${i === k ? ' is-current' : ''}" data-entity="${escapeHTML(entity)}" data-occ="${i}" title="Show this occurrence in the preview">${quoteHTML(previewSpans[spanIndex])}</button></li>`).join('')}</ol>`;
        } else {
            const k = Math.max(0, Math.min(occurrenceCursor.get(entity) ?? 0, idxs.length - 1));
            body = `<div class="mapping-quote">${quoteHTML(previewSpans[idxs[k]])}</div>`;
        }
    }
    return `<div class="mapping-original-text"><span class="mapping-original-name" title="Click to show in the preview (click again for the next occurrence)">${escapeHTML(entity)}</span>${badge}${showBtn}</div>${body}`;
}

function findMappingRow(entity) {
    if (!mappingTableBody) return null;
    for (const tr of mappingTableBody.querySelectorAll('tr[data-entity]')) {
        if (tr.dataset.entity === entity) return tr;
    }
    return null;
}

function refreshOriginalCell(entity) {
    const row = findMappingRow(entity);
    const cell = row ? row.querySelector('.mapping-original-cell') : null;
    if (cell) cell.innerHTML = renderOriginalCellHTML(entity);
}

// Highlight one entity everywhere (table row + every preview mark) without a
// full re-render.
function setActiveEntity(entity) {
    activeEntity = entity || null;
    anonPreviewText?.querySelectorAll('mark.anon-hl.is-active').forEach((m) => m.classList.remove('is-active'));
    mappingTableBody?.querySelectorAll('tr.is-active').forEach((r) => r.classList.remove('is-active'));
    if (!activeEntity) return;
    anonPreviewText?.querySelectorAll('mark.anon-hl').forEach((m) => {
        if (m.dataset.entity === activeEntity) m.classList.add('is-active');
    });
    findMappingRow(activeEntity)?.classList.add('is-active');
}

function scrollPreviewToElement(el) {
    if (!el || !anonPreviewText) return;
    const target = el.offsetTop - anonPreviewText.clientHeight / 2 + el.offsetHeight / 2;
    anonPreviewText.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    const rect = anonPreviewText.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
        anonPreviewText.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function flashMark(mark) {
    if (!mark) return;
    mark.classList.remove('is-flash');
    void mark.offsetWidth; // restart the animation
    mark.classList.add('is-flash');
    setTimeout(() => mark.classList.remove('is-flash'), 1200);
}

// Jump the preview to the next (step=1) or previous (step=-1) occurrence of
// an entity. Entities without occurrences fall back to a raw text search so a
// filtered / removed item can still be located (and re-added via selection).
function jumpToEntity(entity, step = 1, { occurrence = null } = {}) {
    if (!entity) return;
    const idxs = previewOccurrences.get(entity) || [];
    if (idxs.length === 0) {
        setActiveEntity(currentMapping.entities[entity] ? entity : null);
        jumpToRawText(entity);
        return;
    }
    setActiveEntity(entity);
    const prev = occurrenceCursor.has(entity) ? occurrenceCursor.get(entity) : -1;
    const k = occurrence !== null
        ? Math.max(0, Math.min(occurrence, idxs.length - 1))
        : (((prev + step) % idxs.length) + idxs.length) % idxs.length;
    occurrenceCursor.set(entity, k);
    const mark = anonPreviewText?.querySelector(`mark[data-span="${idxs[k]}"]`);
    scrollPreviewToElement(mark);
    flashMark(mark);
    refreshOriginalCell(entity);
}

// Select the first raw occurrence of `needle` inside the preview text nodes.
// Selecting it triggers the quick-tag popover, which is exactly the right
// affordance for a dropped suggestion the user wants back.
function jumpToRawText(needle) {
    if (!anonPreviewText || !needle) return false;
    const target = normalizeForMatch(needle);
    if (!target) return false;
    const walker = document.createTreeWalker(anonPreviewText, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: full.length });
        full += n.nodeValue;
    }
    const idx = full.toLowerCase().indexOf(target);
    if (idx < 0) return false;
    const locate = (offset) => {
        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].start <= offset) return { node: nodes[i].node, offset: offset - nodes[i].start };
        }
        return { node: nodes[0].node, offset: 0 };
    };
    const range = document.createRange();
    const a = locate(idx);
    const b = locate(idx + target.length);
    range.setStart(a.node, Math.min(a.offset, a.node.length));
    range.setEnd(b.node, Math.min(b.offset, b.node.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rect = range.getBoundingClientRect();
    const preRect = anonPreviewText.getBoundingClientRect();
    anonPreviewText.scrollTo({ top: Math.max(0, anonPreviewText.scrollTop + (rect.top - preRect.top) - anonPreviewText.clientHeight / 2), behavior: 'smooth' });
    if (preRect.top < 0 || preRect.bottom > window.innerHeight) {
        anonPreviewText.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (typeof showSelectionPopover === 'function') setTimeout(showSelectionPopover, 400);
    return true;
}

// Preview = source text with every entity occurrence wrapped in a clickable
// <mark>. In 'anonymized' mode the mark shows the replacement tag (identical
// to the downloaded text); in 'original' mode it shows the detected text.
function renderPreview() {
    if (!anonPreviewText) return;
    const entryCount = Object.keys(currentMapping.entities).length;
    if (typeof anonSourceText !== 'string') {
        anonPreviewText.textContent = anonDocType === 'excel'
            ? `Excel file anonymized. ${entryCount} entities replaced across selected columns.`
            : '';
        anonPreviewText.classList.remove('is-original');
        if (anonPreviewMeta) anonPreviewMeta.textContent = '';
        return;
    }
    const truncated = anonSourceText.length > PREVIEW_MAX_CHARS;
    const text = truncated ? anonSourceText.slice(0, PREVIEW_MAX_CHARS) : anonSourceText;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (let i = 0; i < previewSpans.length; i++) {
        const span = previewSpans[i];
        if (span.start >= text.length) break;
        if (span.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, span.start)));
        const mark = document.createElement('mark');
        mark.className = `anon-hl entity-hl-${String(span.type).toLowerCase()}${span.entity === activeEntity ? ' is-active' : ''}${span.disabled ? ' is-disabled' : ''}`;
        mark.dataset.span = String(i);
        mark.dataset.entity = span.entity;
        mark.title = span.disabled
            ? `${span.entity} (${span.type}) is switched off: it stays in the output as-is. Click to review.`
            : `${span.entity} → ${span.replacement} (${span.type}). Click to review.`;
        mark.textContent = (previewMode === 'original' || span.disabled) ? text.slice(span.start, span.end) : span.replacement;
        frag.appendChild(mark);
        cursor = Math.min(span.end, text.length);
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    if (truncated) {
        const note = document.createElement('div');
        note.className = 'anon-preview-truncated';
        note.textContent = `Preview shows the first ${PREVIEW_MAX_CHARS.toLocaleString()} characters; the download contains the full document.`;
        frag.appendChild(note);
    }
    anonPreviewText.replaceChildren(frag);
    anonPreviewText.classList.toggle('is-original', previewMode === 'original');
    if (anonPreviewMeta) {
        const chars = typeof anonymizedResult === 'string' ? anonymizedResult.length : anonSourceText.length;
        const scope = anonDocType === 'excel' ? ' · selected cells' : '';
        const replaced = previewSpans.filter((sp) => !sp.disabled).length;
        const off = Object.values(currentMapping.entities).filter((info) => !isEntityEnabled(info)).length;
        anonPreviewMeta.textContent = `(${chars.toLocaleString()} chars · ${entryCount} entities${off ? `, ${off} off` : ''} · ${replaced} occurrences replaced${scope})`;
    }
}

// ── Undo ─────────────────────────────────────────────────────────────────────
function snapshotMapping() {
    return {
        entities: JSON.parse(JSON.stringify(currentMapping.entities)),
        counters: { ...currentMapping.counters },
        manual: [...manualEntities],
    };
}

function pushUndo() {
    undoStack.push(snapshotMapping());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoButton();
}

function undoLastMappingChange() {
    const snap = undoStack.pop();
    if (!snap) return;
    currentMapping.entities = snap.entities;
    currentMapping.counters = snap.counters;
    manualEntities = new Set(snap.manual);
    updateUndoButton();
    reapplyMapping({ renumber: false });
}

function updateUndoButton() {
    if (!mappingUndoBtn) return;
    mappingUndoBtn.disabled = undoStack.length === 0;
    mappingUndoBtn.textContent = undoStack.length ? `Undo (${undoStack.length})` : 'Undo';
}

function resetReviewState() {
    undoStack.length = 0;
    activeEntity = null;
    occurrenceCursor = new Map();
    unfoldedEntities.clear();
    updateUndoButton();
    if (anonEntityPopover) anonEntityPopover.hidden = true;
}

function setEntityEnabled(entity, enabled) {
    const info = currentMapping.entities[entity];
    if (!info || isEntityEnabled(info) === !!enabled) return;
    pushUndo();
    if (enabled) delete info.disabled; else info.disabled = true;
    reapplyMapping();
}

function removeEntityFromMapping(entity) {
    if (!entity || !currentMapping.entities[entity]) return;
    pushUndo();
    delete currentMapping.entities[entity];
    manualEntities.delete(entity);
    occurrenceCursor.delete(entity);
    if (activeEntity === entity) activeEntity = null;
    reapplyMapping();
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Live mapping edits (add / remove / undo → re-apply) ───────────────────
// Re-applies the mapping to the saved source (text) or to the captured
// sheet/columns (Excel) so the preview and the downloaded output instantly
// reflect every mapping edit. No model is involved.
function reapplyMapping({ renumber = true } = {}) {
    // Compact replacement numbers so the user never sees gaps like
    // [PERSON_1], [PERSON_3], [PERSON_5] after deletions / merges.
    // Undo skips this so the restored snapshot is exact.
    if (renumber) renumberMapping();
    if (anonDocType === 'excel') {
        if (anonWorkbook && anonExcelRunConfig) anonymizedResult = applyMappingToWorkbook();
    } else if (typeof anonSourceText === 'string') {
        anonymizedResult = anonymizeText(anonSourceText);
    }
    renderResults();
}

// Build the list of unique replacements currently in use (so users can pick
// one as an alias for a new/existing entity → multiple originals collapse to
// the same tag). Used by the inline add datalist and the selection popover.
function refreshReplacementChoices() {
    const seen = new Map(); // replacement → type (for display hint)
    for (const info of Object.values(currentMapping.entities)) {
        if (isEntityEnabled(info) && info.replacement && !seen.has(info.replacement)) {
            seen.set(info.replacement, info.type);
        }
    }
    const replacements = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (mappingReplacementList) {
        mappingReplacementList.innerHTML = replacements
            .map(([rep, type]) => `<option value="${escapeHTML(rep)}">${escapeHTML(type)}</option>`)
            .join('');
    }
    const aliasSelect = document.getElementById('anonSelectionAlias');
    if (aliasSelect) {
        aliasSelect.innerHTML = '<option value="">—</option>' + replacements
            .map(([rep, type]) => `<option value="${escapeHTML(rep)}">${escapeHTML(rep)} (${escapeHTML(type)})</option>`)
            .join('');
    }
}

// Helper: infer type from an existing replacement (the type the alias group uses)
function typeForReplacement(replacement) {
    for (const info of Object.values(currentMapping.entities)) {
        if (info && info.replacement === replacement) return info.type;
    }
    return null;
}

// ── Auto-renumber replacements ───────────────────────────────────────────
// Keeps each type's numbers contiguous (1, 2, 3, …) and orders them by the
// first occurrence in the source text so the preview reads naturally.
// All aliased entities (multiple originals → same replacement) stay aliased.
function renumberMapping() {
    const entities = currentMapping.entities;
    // Group entities by current replacement (preserving aliases)
    const groups = new Map(); // oldReplacement → { type, originals: [entity, ...], enabled }
    for (const [entity, info] of Object.entries(entities)) {
        if (!info || !info.replacement) continue;
        let g = groups.get(info.replacement);
        if (!g) { g = { type: info.type, originals: [], enabled: false }; groups.set(info.replacement, g); }
        g.originals.push(entity);
        if (isEntityEnabled(info)) g.enabled = true;
    }
    // Determine first-occurrence index in source text for ordering
    const src = typeof anonSourceText === 'string' ? anonSourceText : '';
    function firstIndex(originals) {
        let best = Infinity;
        for (const o of originals) {
            const idx = src ? src.indexOf(o) : -1;
            if (idx >= 0 && idx < best) best = idx;
        }
        return best === Infinity ? Number.MAX_SAFE_INTEGER : best;
    }
    // Bucket groups by type, sort by first occurrence
    const byType = new Map();
    for (const [rep, g] of groups.entries()) {
        if (!byType.has(g.type)) byType.set(g.type, []);
        byType.get(g.type).push({ oldRep: rep, ...g, firstAt: firstIndex(g.originals) });
    }
    // Build old→new replacement map and reset counters
    const remap = new Map();
    currentMapping.counters = {};
    for (const [type, list] of byType.entries()) {
        // Live groups get the low numbers (contiguous in the output); groups
        // that are entirely switched off follow, so they never collide.
        list.sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || (a.firstAt - b.firstAt));
        currentMapping.counters[type] = list.length;
        list.forEach((g, i) => {
            const newRep = `[${type}_${i + 1}]`;
            remap.set(g.oldRep, newRep);
        });
    }
    // Apply remap (only rewrite when the value actually changes)
    for (const info of Object.values(entities)) {
        const next = remap.get(info.replacement);
        if (next && next !== info.replacement) info.replacement = next;
    }
}

// ── Smart bundling (heuristic person grouping) ───────────────────────────
// Conservative rules — only merges when it's near-certain to be the same person:
//   1. Both entries are PERSON.
//   2. Same lowercased surname (last alphabetic token of length >= 2).
//   3. First-name component is COMPATIBLE:
//        - one side has no first name (e.g. "Puts"), OR
//        - first names match exactly (case-insensitive), OR
//        - one side has just an initial that matches the other side's first
//          letter (e.g. "S. Puts" ↔ "Sander Puts").
//   4. After grouping, all members of the group merge into the single most
//      "complete" original (the one with the most name tokens) and adopt
//      its replacement tag. Renumbering then closes any resulting gaps.
function tokenizeName(s) {
    return String(s).split(/\s+/).filter(Boolean);
}
function isInitialToken(tok) {
    // "S.", "S", "J.P."  → initial-like
    return /^[A-Z](\.|$)/.test(tok) || /^([A-Z]\.){1,3}$/.test(tok);
}
function initialOf(tok) {
    return tok.replace(/[^A-Za-z]/g, '').charAt(0).toLowerCase();
}
function splitName(full) {
    const toks = tokenizeName(full);
    if (toks.length === 0) return { firsts: [], surname: '' };
    // Treat lowercase tussenvoegsel ("van", "de", "der", "den", "ter", "van der") as part of surname
    const tussen = new Set(['van', 'de', 'der', 'den', 'ter', 'ten', 'op', 'op de', 'in', 'in t', 'het']);
    // Find first index where the rest is "tussenvoegsel(s) + capitalised surname"
    let surnameStart = toks.length - 1;
    for (let i = 0; i < toks.length - 1; i++) {
        if (tussen.has(toks[i].toLowerCase()) && i < toks.length - 1) {
            surnameStart = i;
            break;
        }
    }
    const firsts = toks.slice(0, surnameStart);
    const surname = toks.slice(surnameStart).join(' ');
    return { firsts, surname };
}
function namesCompatible(a, b) {
    // a, b → { firsts: [...], surname }
    if (a.surname.toLowerCase() !== b.surname.toLowerCase()) return false;
    if (a.firsts.length === 0 || b.firsts.length === 0) return true;
    // Compare first-name token-by-token
    const n = Math.min(a.firsts.length, b.firsts.length);
    for (let i = 0; i < n; i++) {
        const ai = a.firsts[i], bi = b.firsts[i];
        const aIni = isInitialToken(ai), bIni = isInitialToken(bi);
        if (aIni || bIni) {
            if (initialOf(ai) !== initialOf(bi)) return false;
        } else if (ai.toLowerCase() !== bi.toLowerCase()) {
            return false;
        }
    }
    return true;
}
function smartBundlePersons() {
    const persons = Object.entries(currentMapping.entities)
        .filter(([, info]) => isEntityEnabled(info) && info.type === 'PERSON')
        .map(([entity, info]) => ({ entity, info, parts: splitName(entity) }))
        .filter(p => p.parts.surname);
    if (persons.length < 2) return 0;
    // Union-find by compatibility (group transitively)
    const parent = persons.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < persons.length; i++) {
        for (let j = i + 1; j < persons.length; j++) {
            if (namesCompatible(persons[i].parts, persons[j].parts)) union(i, j);
        }
    }
    // Build groups
    const groups = new Map(); // root → [indices]
    for (let i = 0; i < persons.length; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(i);
    }
    let merged = 0;
    for (const idxs of groups.values()) {
        if (idxs.length < 2) continue;
        // Skip groups already collapsed to a single replacement
        const reps = new Set(idxs.map(i => persons[i].info.replacement));
        if (reps.size < 2) continue;
        // Pick the "anchor" = entity with the most name tokens (longest as tie-break)
        idxs.sort((a, b) => {
            const ta = tokenizeName(persons[a].entity).length;
            const tb = tokenizeName(persons[b].entity).length;
            if (tb !== ta) return tb - ta;
            return persons[b].entity.length - persons[a].entity.length;
        });
        const anchorRep = persons[idxs[0]].info.replacement;
        for (const i of idxs) {
            persons[i].info.replacement = anchorRep;
        }
        merged += idxs.length - 1;
    }
    return merged;
}

if (mappingAddBtn) {
    mappingAddBtn.addEventListener('click', () => {
        const entityRaw = (mappingAddEntity?.value || '').trim();
        if (entityRaw.length < 2) {
            alert('Entity must be at least 2 characters.');
            return;
        }
        let type = (mappingAddType?.value || 'MISC').trim().toUpperCase();
        let replacement = (mappingAddReplacement?.value || '').trim();
        // If the chosen replacement is an existing tag → alias to that group
        // and adopt the group's type so the type tag stays consistent.
        const aliasedType = replacement ? typeForReplacement(replacement) : null;
        if (aliasedType) {
            type = aliasedType;
        } else if (!replacement) {
            if (!currentMapping.counters[type]) currentMapping.counters[type] = 0;
            currentMapping.counters[type]++;
            replacement = `[${type}_${currentMapping.counters[type]}]`;
        }
        pushUndo();
        currentMapping.entities[entityRaw] = { type, replacement };
        manualEntities.add(entityRaw);
        if (mappingAddEntity) mappingAddEntity.value = '';
        if (mappingAddReplacement) mappingAddReplacement.value = '';
        reapplyMapping();
    });

    mappingAddEntity?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); mappingAddBtn.click(); }
    });
}

// Smart-bundle button: heuristic person grouping + auto-renumber
const mappingSmartBundleBtn = document.getElementById('mappingSmartBundleBtn');
if (mappingSmartBundleBtn) {
    mappingSmartBundleBtn.addEventListener('click', () => {
        pushUndo();
        const merged = smartBundlePersons();
        if (merged === 0) {
            undoStack.pop();
            updateUndoButton();
            // Still renumber in case there are gaps to close.
            reapplyMapping();
            mappingSmartBundleBtn.textContent = 'Smart bundle (no merges)';
            setTimeout(() => { mappingSmartBundleBtn.textContent = 'Smart bundle'; }, 1500);
            return;
        }
        reapplyMapping();
        mappingSmartBundleBtn.textContent = `Smart bundle (−${merged})`;
        setTimeout(() => { mappingSmartBundleBtn.textContent = 'Smart bundle'; }, 1500);
    });
}

// Renumber-only button: just compact the numbers, no merging.
const mappingRenumberBtn = document.getElementById('mappingRenumberBtn');
if (mappingRenumberBtn) {
    mappingRenumberBtn.addEventListener('click', () => {
        pushUndo();
        reapplyMapping();
    });
}

if (mappingTableBody) {
    mappingTableBody.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.mapping-delete-btn');
        if (delBtn) {
            removeEntityFromMapping(delBtn.getAttribute('data-entity'));
            return;
        }
        // "Show in text" → unfold every occurrence and jump to the first
        const showBtn = e.target.closest('.mapping-show-btn');
        if (showBtn) {
            const entity = showBtn.getAttribute('data-entity');
            if (unfoldedEntities.has(entity)) {
                unfoldedEntities.delete(entity);
                refreshOriginalCell(entity);
            } else {
                unfoldedEntities.add(entity);
                jumpToEntity(entity, 1, { occurrence: occurrenceCursor.get(entity) ?? 0 });
            }
            return;
        }
        // One quote in the unfolded list → that occurrence
        const occItem = e.target.closest('.mapping-occ-item');
        if (occItem) {
            jumpToEntity(occItem.getAttribute('data-entity'), 1, { occurrence: Number(occItem.getAttribute('data-occ')) || 0 });
            return;
        }
        // Click the entity name → show it in the preview (cycles occurrences)
        if (e.target.closest('.mapping-original-name') || e.target.closest('.mapping-occ')) {
            const cell = e.target.closest('.mapping-original-cell');
            if (cell) jumpToEntity(cell.getAttribute('data-entity'));
            return;
        }
        // Click the replacement cell → make it inline-editable
        const cell = e.target.closest('.mapping-replacement-cell');
        if (cell && cell.getAttribute('contenteditable') !== 'true') {
            const entity = cell.getAttribute('data-entity');
            if (!entity || !currentMapping.entities[entity]) return;
            cell.setAttribute('contenteditable', 'true');
            cell.textContent = currentMapping.entities[entity].replacement;
            cell.focus();
            // Select all contents for quick overwrite
            const range = document.createRange();
            range.selectNodeContents(cell);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    // Checkbox → switch the entity on/off in the output (kept in the list)
    mappingTableBody.addEventListener('change', (e) => {
        const box = e.target.closest('.mapping-toggle');
        if (!box) return;
        setEntityEnabled(box.getAttribute('data-entity'), box.checked);
    });

    mappingTableBody.addEventListener('keydown', (e) => {
        const cell = e.target.closest('.mapping-replacement-cell[contenteditable="true"]');
        if (!cell) return;
        if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); cell.dataset.cancel = '1'; cell.blur(); }
    });

    mappingTableBody.addEventListener('blur', (e) => {
        const cell = e.target.closest('.mapping-replacement-cell[contenteditable="true"]');
        if (!cell) return;
        const entity = cell.getAttribute('data-entity');
        const cancelled = cell.dataset.cancel === '1';
        delete cell.dataset.cancel;
        cell.removeAttribute('contenteditable');
        if (cancelled || !entity || !currentMapping.entities[entity]) {
            renderResults();
            return;
        }
        const newRep = (cell.textContent || '').trim();
        if (!newRep) { renderResults(); return; }
        if (newRep === currentMapping.entities[entity].replacement) { renderResults(); return; }
        // If the new replacement matches an existing group, adopt that group's type.
        const aliasedType = typeForReplacement(newRep);
        pushUndo();
        currentMapping.entities[entity].replacement = newRep;
        if (aliasedType) currentMapping.entities[entity].type = aliasedType;
        reapplyMapping();
    }, true);
}

// ── Quick-tag from preview selection ─────────────────────────────────────
// Select any text inside the preview → a small floating popover appears with
// type buttons. Clicking a type adds the selection to the mapping and live-
// re-applies, just like the inline Add form.
(function setupSelectionPopover() {
    const popover = document.getElementById('anonSelectionPopover');
    const labelText = document.getElementById('anonSelectionText');
    if (!popover || !anonPreviewText) return;

    function hidePopover() { popover.hidden = true; }
    showSelectionPopover = () => showPopoverForSelection();

    function showPopoverForSelection() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hidePopover(); return; }
        const range = sel.getRangeAt(0);
        // Only react when the selection is entirely inside the preview <pre>.
        if (!anonPreviewText.contains(range.commonAncestorContainer)) { hidePopover(); return; }
        const raw = sel.toString();
        const text = raw.trim();
        if (text.length < 2) { hidePopover(); return; }
        // Avoid adding the existing replacement tags themselves
        if (/^\[[A-Z]+_\d+\]$/.test(text)) { hidePopover(); return; }

        labelText.textContent = text.length > 80 ? text.slice(0, 80) + '…' : text;
        popover.dataset.entity = text;

        // Position just below the selection rect, clamped to viewport.
        const rect = range.getBoundingClientRect();
        popover.hidden = false;
        // Measure after un-hiding so width is correct.
        const pw = popover.offsetWidth;
        const ph = popover.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = rect.left + (rect.width / 2) - (pw / 2);
        let top = rect.bottom + 8;
        if (left + pw > vw - 8) left = vw - pw - 8;
        if (left < 8) left = 8;
        if (top + ph > vh - 8) top = rect.top - ph - 8;
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';
    }

    document.addEventListener('mouseup', () => {
        // Defer so the selection is finalized.
        setTimeout(showPopoverForSelection, 0);
    });
    document.addEventListener('keyup', (e) => {
        // Keyboard selection (shift+arrow). Ignore typing inside inputs.
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        showPopoverForSelection();
    });

    // Hide when clicking outside the popover or scrolling the page.
    document.addEventListener('mousedown', (e) => {
        if (popover.hidden) return;
        if (popover.contains(e.target)) return;
        hidePopover();
    });
    window.addEventListener('scroll', hidePopover, true);
    window.addEventListener('resize', hidePopover);

    popover.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-type]');
        if (!btn) return;
        const entity = popover.dataset.entity || '';
        if (entity.length < 2) { hidePopover(); return; }
        const type = btn.getAttribute('data-type').toUpperCase();
        pushUndo();
        if (!currentMapping.counters[type]) currentMapping.counters[type] = 0;
        // Only mint a fresh replacement if this entity is brand new
        if (!currentMapping.entities[entity]) {
            currentMapping.counters[type]++;
            const replacement = `[${type}_${currentMapping.counters[type]}]`;
            currentMapping.entities[entity] = { type, replacement };
            manualEntities.add(entity);
        } else {
            // Already mapped — just update the type (keep replacement)
            currentMapping.entities[entity].type = type;
        }
        hidePopover();
        window.getSelection()?.removeAllRanges();
        reapplyMapping();
    });

    // Alias picker: choosing an existing replacement maps the selection to
    // that group (e.g. "Jan", "J. Janssen" → same [PERSON_1]).
    const aliasSelect = document.getElementById('anonSelectionAlias');
    aliasSelect?.addEventListener('change', () => {
        const replacement = aliasSelect.value;
        if (!replacement) return;
        const entity = popover.dataset.entity || '';
        if (entity.length < 2) { hidePopover(); return; }
        const type = typeForReplacement(replacement) || 'MISC';
        pushUndo();
        currentMapping.entities[entity] = { type, replacement };
        manualEntities.add(entity);
        aliasSelect.value = '';
        hidePopover();
        window.getSelection()?.removeAllRanges();
        reapplyMapping();
    });
})();

// ── Review interactions: highlight popover, preview mode, undo, table jumps ──
(function setupEntityPopover() {
    const popover = anonEntityPopover;
    if (!popover || !anonPreviewText) return;
    const textEl = document.getElementById('anonEntityPopoverText');
    const repEl = document.getElementById('anonEntityPopoverReplacement');
    const typeEl = document.getElementById('anonEntityPopoverType');
    const countEl = document.getElementById('anonEntityPopoverCount');
    let current = null; // entity string shown in the popover

    function hide() { popover.hidden = true; current = null; }

    function positionNear(rect) {
        popover.hidden = false;
        const pw = popover.offsetWidth;
        const ph = popover.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = rect.left + (rect.width / 2) - (pw / 2);
        let top = rect.bottom + 8;
        if (left + pw > vw - 8) left = vw - pw - 8;
        if (left < 8) left = 8;
        if (top + ph > vh - 8) top = rect.top - ph - 8;
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';
    }

    function currentMark() {
        if (!current) return null;
        const idxs = previewOccurrences.get(current) || [];
        const k = occurrenceCursor.get(current) ?? 0;
        return anonPreviewText.querySelector(`mark[data-span="${idxs[k]}"]`);
    }

    function updateCount() {
        const idxs = previewOccurrences.get(current) || [];
        const k = occurrenceCursor.get(current) ?? 0;
        if (countEl) countEl.textContent = idxs.length ? `${k + 1} / ${idxs.length}` : '';
    }

    function show(mark) {
        const entity = mark.dataset.entity;
        const info = currentMapping.entities[entity];
        if (!info) return;
        const idxs = previewOccurrences.get(entity) || [];
        const k = Math.max(0, idxs.indexOf(Number(mark.dataset.span)));
        occurrenceCursor.set(entity, k);
        current = entity;
        if (textEl) textEl.textContent = entity;
        if (repEl) repEl.textContent = isEntityEnabled(info) ? info.replacement : 'kept as-is (off)';
        const toggleBtn = popover.querySelector('[data-entity-action="toggle"]');
        if (toggleBtn) toggleBtn.textContent = isEntityEnabled(info) ? 'Turn off' : 'Turn on';
        if (typeEl) {
            typeEl.textContent = info.type;
            typeEl.className = `entity-tag entity-tag-${String(info.type).toLowerCase()}`;
        }
        updateCount();
        setActiveEntity(entity);
        refreshOriginalCell(entity);
        positionNear(mark.getBoundingClientRect());
    }

    anonPreviewText.addEventListener('click', (e) => {
        const mark = e.target.closest('mark.anon-hl');
        if (!mark) return;
        // A drag-selection that ends on a mark belongs to the quick-tag popover.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        show(mark);
    });

    popover.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-entity-nav]');
        if (nav && current) {
            const entity = current;
            jumpToEntity(entity, Number(nav.getAttribute('data-entity-nav')) || 1);
            updateCount();
            // Re-anchor to the new occurrence once the smooth scroll settles.
            setTimeout(() => {
                if (popover.hidden || current !== entity) return;
                const m = currentMark();
                if (m) positionNear(m.getBoundingClientRect());
            }, 350);
            return;
        }
        const action = e.target.closest('[data-entity-action]');
        if (!action || !current) return;
        const entity = current;
        const kind = action.getAttribute('data-entity-action');
        if (kind === 'table') {
            hide();
            setActiveEntity(entity);
            findMappingRow(entity)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (kind === 'toggle') {
            hide();
            setEntityEnabled(entity, !isEntityEnabled(currentMapping.entities[entity]));
        } else if (kind === 'remove') {
            hide();
            removeEntityFromMapping(entity);
        }
    });

    document.addEventListener('mousedown', (e) => {
        if (popover.hidden || popover.contains(e.target)) return;
        hide();
    });
    // Follow the mark while the preview scrolls; hide on any other scroll.
    window.addEventListener('scroll', (e) => {
        if (popover.hidden) return;
        if (e.target !== anonPreviewText) { hide(); return; }
        const m = currentMark();
        const preRect = anonPreviewText.getBoundingClientRect();
        const r = m ? m.getBoundingClientRect() : null;
        if (!r || r.bottom < preRect.top || r.top > preRect.bottom) { hide(); return; }
        positionNear(r);
    }, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !popover.hidden) hide(); });
})();

anonPreviewModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        previewMode = btn.getAttribute('data-preview-mode') === 'original' ? 'original' : 'anonymized';
        anonPreviewModeButtons.forEach((b) => {
            const active = b === btn;
            b.classList.toggle('is-active', active);
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        if (anonEntityPopover) anonEntityPopover.hidden = true;
        renderPreview();
    });
});

mappingUndoBtn?.addEventListener('click', undoLastMappingChange);

// Detection breakdown rows → show that entity in the preview.
for (const body of [nerDetectionTableBody, llmDetectionTableBody, llmAddedTableBody, nerFilteredTableBody, llmFilteredTableBody]) {
    body?.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-entity]');
        if (tr) jumpToEntity(tr.dataset.entity);
    });
}

// ── Downloads ──────────────────────────────────────────────────────────────────
downloadAnonDocBtn.addEventListener('click', async () => {
    if (!anonymizedResult || !anonDocument) return;
    const baseName = anonDocument.name.replace(/\.[^/.]+$/, '');
    if (anonDocType === 'pdf' && typeof anonymizedResult === 'string') {
        const fmt = anonPdfFormat ? anonPdfFormat.value : 'text';
        if (fmt === 'burnin') {
            // True burn-in redaction on the ORIGINAL PDF, reusing the entities
            // already detected by whichever pipeline the user selected.
            const lib = window.medmorfPdfBurnIn;
            if (!lib || !lib.isAvailable()) {
                alert('PDF burn-in library not loaded yet. Please reload the page and try again.');
                return;
            }
            const detected = Object.entries(currentMapping.entities || {})
                .filter(([, info]) => isEntityEnabled(info))
                .map(([entity]) => entity);
            if (detected.length === 0) {
                alert('No entities detected to redact. Run anonymization first.');
                return;
            }
            // No extra confirm / prompt here — the live preview + mapping editor
            // above is the verification surface. Whatever you can see redacted
            // in the preview is what gets blacked out in the PDF.
            const targets = detected;

            const origLabel = downloadAnonDocBtn.innerHTML;
            downloadAnonDocBtn.disabled = true;
            downloadAnonDocBtn.textContent = 'Redacting PDF… 0%';
            try {
                const { blob, summary } = await lib.redactPdf(anonDocument, targets, {
                    onProgress: (pct, msg) => {
                        const p = Math.max(0, Math.min(100, Math.round(pct)));
                        downloadAnonDocBtn.textContent =
                            (msg ? `${msg} ` : 'Redacting… ') + p + '%';
                    },
                });
                saveAs(blob, `${baseName}_redacted.pdf`);
                console.log('[ANON] burn-in summary', summary);
            } catch (err) {
                console.error('Burn-in redaction failed:', err);
                alert('Burn-in redaction failed: ' + formatAnonymizationError(err));
            } finally {
                downloadAnonDocBtn.disabled = false;
                downloadAnonDocBtn.innerHTML = origLabel;
            }
            return;
        }
        if (fmt === 'txt') {
            const blob = new Blob([anonymizedResult], { type: 'text/plain;charset=utf-8' });
            saveAs(blob, `${baseName}_anonymized.txt`);
            return;
        }
        // Default: text-rebuild PDF
        try {
            const blob = await createAnonymizedPdfBlob(anonymizedResult);
            saveAs(blob, `${baseName}_anonymized.pdf`);
        } catch (err) {
            console.error('PDF generation failed, falling back to .txt:', err);
            const blob = new Blob([anonymizedResult], { type: 'text/plain' });
            saveAs(blob, `${baseName}_anonymized.txt`);
        }
    } else if (typeof anonymizedResult === 'string') {
        const blob = new Blob([anonymizedResult], { type: 'text/plain' });
        saveAs(blob, `${baseName}_anonymized.txt`);
    } else {
        XLSX.writeFile(anonymizedResult, `${baseName}_anonymized.xlsx`);
    }
});

downloadMappingBtn.addEventListener('click', () => {
    const baseName = anonDocument ? anonDocument.name.replace(/\.[^/.]+$/, '') : 'mapping';
    const format = mappingExportFormat ? mappingExportFormat.value : 'xlsx';

    if (format === 'xlsx') {
        const rows = [['Entity', 'Type', 'Replacement']];
        // Only entities that are switched on: the sheet documents what was replaced.
        const entries = Object.entries(currentMapping.entities)
            .filter(([, info]) => isEntityEnabled(info))
            .sort((a, b) => a[1].type.localeCompare(b[1].type));
        for (const [entity, info] of entries) {
            rows.push([entity, info.type, info.replacement]);
        }
        const ws = XLSX.utils.aoa_to_sheet(rows);
        // Set column widths
        ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 20 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Mapping');
        XLSX.writeFile(wb, `${baseName}_mapping.xlsx`);
    } else {
        const json = JSON.stringify(currentMapping, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        saveAs(blob, `${baseName}_mapping.json`);
    }
});

// ── Upload Handlers ────────────────────────────────────────────────────────────
function setupDropArea(area, input, onFile) {
    area.addEventListener('click', () => input.click());
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', (e) => {
        e.preventDefault();
        area.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) onFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) onFile(e.target.files[0]);
    });
}

setupDropArea(anonDocUpload, anonDocInput, async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'docx', 'txt', 'pdf'].includes(ext)) {
        alert('Unsupported file type. Please upload .pdf, .xlsx, .docx, or .txt files.');
        return;
    }
    anonDocument = file;
    anonDocType = ext === 'xlsx' ? 'excel' : (ext === 'pdf' ? 'pdf' : 'text');
    anonDocName.textContent = file.name;
    anonDocInfo.style.display = 'block';
    anonResults.style.display = 'none';
    anonymizedResult = null;

    // Show the PDF output-format picker only for PDFs.
    if (anonPdfFormat) anonPdfFormat.style.display = (anonDocType === 'pdf') ? '' : 'none';

    if (anonDocType === 'excel') {
        const data = await file.arrayBuffer();
        anonWorkbook = XLSX.read(data, { type: 'array' });
        anonSheetSelect.innerHTML = '';
        anonWorkbook.SheetNames.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            anonSheetSelect.appendChild(opt);
        });
        loadAnonSheetColumns(anonWorkbook.SheetNames[0]);
        anonSheetSelect.onchange = (e) => loadAnonSheetColumns(e.target.value);
        anonExcelSettings.style.display = 'block';
    } else {
        anonExcelSettings.style.display = 'none';
    }
    anonymizeBtn.disabled = false;
});

setupDropArea(anonMappingUpload, anonMappingInput, async (file) => {
    try {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'xlsx') {
            const arrayBuffer = await file.arrayBuffer();
            loadMappingFromXLSX(arrayBuffer);
        } else {
            const text = await file.text();
            loadMappingFromJSON(text);
        }
        anonMappingName.textContent = file.name;
        anonMappingInfo.style.display = 'block';
        resetReviewState();
    } catch (e) {
        alert('Invalid mapping file: ' + e.message);
    }
});

// ── Free-text input ────────────────────────────────────────────────────────────
// Lets users paste raw text instead of uploading a file. We synthesise a
// File object so the rest of the anonymize pipeline works unchanged.
const anonPasteText = document.getElementById('anonPasteText');
const anonPasteUseBtn = document.getElementById('anonPasteUseBtn');
const anonPasteClearBtn = document.getElementById('anonPasteClearBtn');
const anonPasteStatus = document.getElementById('anonPasteStatus');

if (anonPasteUseBtn && anonPasteText) {
    anonPasteUseBtn.addEventListener('click', () => {
        const text = (anonPasteText.value || '').trim();
        if (text.length < 1) {
            if (anonPasteStatus) anonPasteStatus.textContent = 'Paste some text first.';
            return;
        }
        // Synthesise a text/plain File so the existing extractTextFromDocument()
        // → file.text() path works without any branching.
        const name = `pasted-text-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        const file = new File([text], name, { type: 'text/plain' });
        anonDocument = file;
        anonDocType = 'text';
        if (anonDocName) anonDocName.textContent = name;
        if (anonDocInfo) anonDocInfo.style.display = 'block';
        if (anonResults) anonResults.style.display = 'none';
        anonymizedResult = null;
        if (anonPdfFormat) anonPdfFormat.style.display = 'none';
        if (anonExcelSettings) anonExcelSettings.style.display = 'none';
        if (anonymizeBtn) anonymizeBtn.disabled = false;
        if (anonPasteStatus) {
            anonPasteStatus.textContent = `Loaded ${text.length.toLocaleString()} characters. Click Anonymize to process.`;
        }
    });
}

if (anonPasteClearBtn && anonPasteText) {
    anonPasteClearBtn.addEventListener('click', () => {
        anonPasteText.value = '';
        if (anonPasteStatus) anonPasteStatus.textContent = '';
    });
}

if (clearAnonMappingBtn) {
    clearAnonMappingBtn.addEventListener('click', () => {
        currentMapping = { version: 1, entities: {}, counters: {} };
        anonMappingInfo.style.display = 'none';
        anonMappingInput.value = '';
        updateMappingCount();
    });
}

if (anonNerModelSelect) {
    anonNerModelSelect.addEventListener('change', async () => {
        anonNerModelSelect.dataset.userChanged = '1';
        savePref(LS_KEY_NER_MODEL, anonNerModelSelect.value);
        updateNerModelHint();
        updatePipelineControls();
        updateModeBanner();
        if (getNERPipeline()) {
            await disposeNERPipeline();
        }
    });
}

if (anonModelSelect) {
    anonModelSelect.addEventListener('change', () => {
        anonModelSelect.dataset.userChanged = '1';
        anonModelSelect.dataset.userChosen = '1';
        savePref(LS_KEY_LLM_MODEL, anonModelSelect.value);
        updatePipelineControls();
        updateModeBanner();
    });
}

if (anonModelGrid) {
    anonModelGrid.addEventListener('click', (event) => {
        const card = event.target.closest('.anon-model-card');
        if (card) handleModelCardClick(card);
    });
}

if (glinerThresholdInput) {
    glinerThresholdInput.addEventListener('input', () => {
        if (glinerThresholdValue) {
            glinerThresholdValue.textContent = glinerThresholdInput.value;
        }
    });
}

if (anonResourceInfoBtn && anonResourceInfo) {
    anonResourceInfoBtn.addEventListener('click', () => {
        const nextHidden = !anonResourceInfo.hidden ? true : false;
        anonResourceInfo.hidden = nextHidden;
        anonResourceInfoBtn.setAttribute('aria-expanded', String(!nextHidden));
    });
}

if (anonPipelineSelect) {
    anonPipelineSelect.addEventListener('change', () => {
        anonPipelineSelect.dataset.userChanged = '1';
        savePref(LS_KEY_PIPELINE, anonPipelineSelect.value);
        updatePipelineControls();
        updateNerModelHint();
        updateModeBanner();
    });
}

anonymizeBtn.addEventListener('click', () => performAnonymization());

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (btn.dataset.tab !== 'anonymize') {
            await disposeNERPipeline();
            await disposeAnonModel();
        }
    });
});

// Expose in-memory data status for the Storage tab
window.medmorfAnonymizeData = {
    hasDocument: () => anonDocument !== null,
    documentName: () => anonDocument ? anonDocument.name : null,
    hasResult: () => anonymizedResult !== null,
    hasMapping: () => Object.keys(currentMapping.entities).length > 0,
    mappingCount: () => Object.keys(currentMapping.entities).length,
    // ?anon-debug=1 only: render a result panel from given text + entities so the
    // review UI (quotes, highlights, toggles, undo) can be tested without loading
    // any model. Never used in normal operation.
    debugSeed: (!new URLSearchParams(location.search).has('anon-debug')) ? undefined : ({ text, entities = [], source = 'llm' }) => {
        anonDocument = new File([text], 'debug-seed.txt', { type: 'text/plain' });
        anonDocType = 'text';
        anonWorkbook = null;
        anonSourceText = String(text);
        currentMapping = { version: 1, entities: {}, counters: {} };
        manualEntities = new Set();
        resetDetectionBreakdown(source);
        resetReviewState();
        recordDetectedEntities(source === 'ner' ? 'ner' : 'llm', entities);
        for (const { entity, type } of entities) getOrCreateReplacement(entity, type);
        anonymizedResult = anonymizeText(anonSourceText);
        if (anonDocInfo) anonDocInfo.style.display = 'block';
        if (anonDocName) anonDocName.textContent = anonDocument.name;
        renderResults();
        return { entities: Object.keys(currentMapping.entities).length, spans: previewSpans.length };
    },
    clearAll: async () => {
        anonDocument = null;
        anonDocType = null;
        anonWorkbook = null;
        anonymizedResult = null;
        currentMapping = { version: 1, entities: {}, counters: {} };
        anonSourceText = null;
        anonExcelRunConfig = null;
        manualEntities = new Set();
        resetDetectionBreakdown(getSelectedPipeline());
        resetReviewState();
        await disposeNERPipeline();
        await disposeAnonModel();
        if (anonDocInput) anonDocInput.value = '';
        if (anonMappingInput) anonMappingInput.value = '';
        if (anonDocInfo) anonDocInfo.style.display = 'none';
        if (anonMappingInfo) anonMappingInfo.style.display = 'none';
        if (anonResults) anonResults.style.display = 'none';
        if (anonExcelSettings) anonExcelSettings.style.display = 'none';
        if (anonymizeBtn) anonymizeBtn.disabled = true;
        updateMappingCount();
        console.log('[PRIVACY] All anonymization data cleared');
    }
};

// Init
initializeAnonymizeControls();
console.log('[ANONYMIZE] Anonymization module loaded');
console.log('[ANONYMIZE] Default model:', DEFAULT_MODEL);
