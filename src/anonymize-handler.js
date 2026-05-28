// Medical Data Anonymization — Hybrid NER + LLM pipeline
// NER: ai4privacy multilingual PII detector (ModernBERT, transformers.js v3)
// LLM: Qwen3 (WebLLM/WebGPU) for additional PII verification
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
} from './privacy-runtime.js?v=2026-05-28-browser-limits-1';
import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-05-28-resource-1';
import {
    classifyModelRisk,
    describeMemoryCeiling,
    getCapabilities,
    getCapabilitiesSync,
    getRuntimeMemorySnapshot,
    recommendDefault,
} from './device-capabilities.js?v=2026-05-28-resource-1';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';

const DEFAULT_MODEL = 'Qwen3-4B-q4f16_1-MLC';
const DEFAULT_MAX_CHUNK_CHARS = 1200;
const LOW_MEMORY_MAX_CHUNK_CHARS = 700;

const LLM_MODEL_OPTIONS = {
    'Qwen3-0.6B-q4f16_1-MLC': {
        label: 'Qwen3 0.6B',
        size: '~1.4 GB',
        sizeMB: 1400,
        note: 'Smallest & fastest. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-1.7B-q4f16_1-MLC': {
        label: 'Qwen3 1.7B',
        size: '~2 GB',
        sizeMB: 2000,
        note: 'Good balance of speed and quality. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-4B-q4f16_1-MLC': {
        label: 'Qwen3 4B',
        size: '~3.4 GB',
        sizeMB: 3400,
        note: 'Best instruction-following at this size. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-8B-q4f16_1-MLC': {
        label: 'Qwen3 8B',
        size: '~5.7 GB',
        sizeMB: 5700,
        note: 'Highest quality, needs ≥6 GB VRAM. Requires WebGPU.',
        engine: 'webllm',
    },
};

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
};

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

// Pick the best pipeline for this device automatically
function applySmartDefaults() {
    if (!anonPipelineSelect) return;
    if (anonPipelineSelect.dataset.userChanged === '1') {
        updatePipelineControls();
        if (typeof updateNerModelHint === 'function') updateNerModelHint();
        return; // respect user override
    }
    if (hasWebGPU) {
        anonPipelineSelect.value = 'llm';
    } else {
        anonPipelineSelect.value = 'ner';
        if (anonNerModelSelect && anonNerModelSelect.dataset.userChanged !== '1') {
            // Multilingual PII NER runs well on CPU
            anonNerModelSelect.value = 'multilang_pii';
        }
    }
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
    // Auto-downshift: if device profile is known, recommend a smaller default
    // to avoid OOM on first-load before the user opens the model picker.
    const candidates = Object.entries(LLM_MODEL_OPTIONS).map(([id, o]) => ({ id, sizeMB: o.sizeMB }));
    // Honour any persisted user choice first; otherwise fall back to recommended.
    const stored = loadStoredPref(LS_KEY_LLM_MODEL);
    const recommended = recommendDefault(candidates) || DEFAULT_MODEL;
    const desired = (stored && LLM_MODEL_OPTIONS[stored]) ? stored : recommended;
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
        _llmSelectAutoSet = true;
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

async function initAnonModel() {
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
        title: 'Load language model?',
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
                engine = await CreateMLCEngine(selectedModel, {
                    initProgressCallback: (progress) => {
                        const text = progress.text || '';
                        const pctMatch = text.match(/(\d+(?:\.\d+)?)%/);
                        if (pctMatch) {
                            anonModelProgress.style.width = pctMatch[1] + '%';
                        }
                        anonModelStatusText.textContent = text || 'Loading...';
                        updateStatus('loading', text || 'Loading anonymization model...');
                    },
                });
            }

            anonModelStatusText.textContent = 'Anonymization model loaded ✓';
            anonModelProgress.style.width = '100%';
            loadedModelId = selectedModel;
            registerLoadedModel('anon-llm', disposeAnonModel, { sizeMB: modelOption.sizeMB || 0 });
            updateStatus('idle', 'System Ready');
            setTimeout(() => { anonModelStatus.style.display = 'none'; }, 2000);
        } catch (error) {
            console.error('Anonymization model loading error:', error);
            let userMsg = error.message;
            if (userMsg.includes('Cannot fetch')) {
                userMsg = `Model download failed. Try: (1) clear LLM cache in Storage tab, (2) hard-refresh (⌘⇧R), (3) check that nothing blocks huggingface.co. If using Safari, try Chrome/Edge instead.`;
            }
            anonModelStatusText.textContent = 'Error: ' + userMsg;
            updateStatus('idle', 'Model loading failed');
            engine = null;
            throw error;
        } finally {
            isAnonModelLoading = false;
        }
    });
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
        temperature: options.temperature ?? 0,
    });
    return reply.choices[0].message.content || '';
}

function getSelectedNerModelId() {
    return anonNerModelSelect ? anonNerModelSelect.value : DEFAULT_NER_MODEL_ID;
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
        if (option.id === DEFAULT_NER_MODEL_ID) {
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
        title: 'Load NER model?',
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
    console.log('[NER] Running chunk', {
        modelId: getActiveNERModelId(),
        load: getActiveNERLoadLabel(),
        length: text.length,
        preview: text.slice(0, 200),
    });
    const aggregated = await pipeline(text, {
        aggregation_strategy: 'simple',
        ignore_labels: ['O'],
    });

    console.log('[NER] Aggregated output for chunk:', aggregated);
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

    console.log('[NER] Mapped entities:', entities);
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

    console.log('[GLiNER] Raw results:', results[0]);

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
            console.log(`[GLiNER] Pre-filtered garbage: "${entity}" → ${type}`);
            continue;
        }
        const key = `${entity.toLowerCase()}::${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push({ entity, type, score: item.score });
    }

    console.log('[GLiNER] Mapped entities:', entities);
    return entities;
}

// Pre-filter obvious GLiNER false positives that no LLM review is needed for
function isObviousGarbage(entity, type) {
    const lower = entity.toLowerCase().replace(/\s+/g, ' ').trim();

    // Single words that are never PII regardless of type
    const commonWords = new Set([
        'ja', 'nee', 'ok', 'oké', 'goed', 'prima', 'dank', 'dank u', 'bedankt',
        'hallo', 'dag', 'goedemorgen', 'goedemiddag', 'goedenavond',
        'wat', 'wie', 'waar', 'wanneer', 'hoe', 'waarom',
        'mij', 'mijn', 'uw', 'u', 'hij', 'zij', 'wij', 'hun', 'hem', 'haar',
        'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien',
        'patiënt', 'patiënte', 'pati', 'patient',
        'noodgevallen', 'vermoeidheid', 'klachten', 'medicatie', 'behandeling',
        'contactpersoon', 'contactgegevens', 'rijbewijsnummer', 'telefoonnummer',
        'mijn vrouw', 'mijn man', 'mijn huisarts', 'mijn zoon', 'mijn dochter',
        'mijn iban', 'mijn bsn',
    ]);
    if (commonWords.has(lower)) return true;

    // ID_NUMBER: must contain at least one digit to be a real identifier
    if (type === 'ID_NUMBER' && !/\d/.test(entity)) return true;

    // LOCATION: must look like a place name (capitalized) or address, not a common word
    if (type === 'LOCATION' && entity.length < 3 && !/\d/.test(entity)) return true;

    // Phrases that are clearly conversational, not PII
    if (/^(kunt u|heeft u|ik ben|ik heb|wilt u|mag ik|kan ik)\b/i.test(lower)) return true;

    // Multi-word phrases that don't contain any capitalized word (likely not a name/place)
    if ((type === 'PERSON' || type === 'ORGANIZATION') && entity.split(/\s+/).length > 1) {
        const hasCapital = entity.split(/\s+/).some(w => /^[A-Z\u00C0-\u024F]/.test(w));
        if (!hasCapital) return true;
    }

    return false;
}

const SYSTEM_PROMPT = `You are a medical data anonymization expert. Identify ALL personally identifiable information (PII) in the given medical/clinical text.

Entity types to detect:
- PERSON: Any person names (patients, doctors, family members, nurses, children, spouses, emergency contacts)
- LOCATION: Cities, towns, countries, regions, municipalities
- DATE: Any dates (birth dates, visit dates, admission dates, year-only birth years like "2012" or "2015")
- PHONE: Phone numbers, fax numbers
- EMAIL: Email addresses
- ADDRESS: Street addresses, postal/zip codes, house numbers, standalone street names when they identify a place
- ORGANIZATION: Hospital names, clinic names, insurance companies, employers, schools, practices, companies
- ID_NUMBER: Patient IDs, BSN/SSN numbers, insurance numbers, medical record numbers, IBAN, driver license numbers
- AGE: Specific ages mentioned

Rules:
1. Return ONLY a valid JSON array with "entity" and "type" fields.
2. "entity" must be the EXACT text as it appears in the input.
3. Do NOT include diagnoses, symptoms, medications, or generic medical terms.
4. No explanations, no markdown, no thinking. ONLY the JSON array.
5. If no PII found, return: []

Important examples:
- In "Lucas de Vries (geboren 2012) en Emma de Vries (geboren 2015). Ze zitten op de basisschool De Horizon in Maastricht.", detect "Lucas de Vries" and "Emma de Vries" as PERSON, "2012" and "2015" as DATE, "De Horizon" as ORGANIZATION, and "Maastricht" as LOCATION.
- In "Dr. Anne Jansen van Huisartsenpraktijk Sint Pieter", detect "Anne Jansen" as PERSON and "Huisartsenpraktijk Sint Pieter" as ORGANIZATION.

Example: [{"entity":"Jan de Vries","type":"PERSON"},{"entity":"Amsterdam UMC","type":"ORGANIZATION"}]`;

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

const SYSTEM_PROMPT_VALIDATE = `You are a medical data anonymization expert. A NER model detected the entities listed below, but it produced some false positives. Your task is to identify which detected entities are FALSE POSITIVES (NOT real PII) and should be REMOVED.

An entity is a FALSE POSITIVE if:
- PERSON: Not an actual person name. E.g. "mijn huisarts", "mijn vrouw", "contactpersoon" are roles/descriptions, not names. Real names: "Jan de Vries", "Dr. Jansen".
- LOCATION: Not an actual place name. E.g. "noodgevallen", "vermoeidheid", "mij" are common words. Real places: "Utrecht", "Maastricht".
- ID_NUMBER: Not an actual identifier value. E.g. "Goedemiddag", "Ja", "Wat", "Dank u" are conversational words. Real IDs: "731245689", "NL91 ABNA 0417 1643 00".
- ORGANIZATION: Not an actual organization name. E.g. "het ziekenhuis" is generic. Real: "TechSolutions BV", "Amsterdam UMC".
- WRONG TYPE: Entity exists but has wrong type. E.g. a person name classified as LOCATION, or an address classified as PERSON.

Return ONLY a JSON array of the FALSE POSITIVES to REMOVE. Each item needs "entity" (exact text) and "reason" (brief why).
If ALL entities are valid PII, return: []
No explanations outside the JSON. ONLY the JSON array.

Example: [{"entity":"mijn huisarts","reason":"role description, not a name"},{"entity":"noodgevallen","reason":"common word, not a location"}]`;

async function validateEntitiesWithLLM(entities, text) {
    if (!entities.length || !engine) return entities;

    const entityList = entities.map(e => `- "${e.entity}" → ${e.type}`).join('\n');
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT_VALIDATE },
        { role: 'user', content: `Original text:\n${text}\n\nEntities detected by NER:\n${entityList}\n\nReturn ONLY the false positives to REMOVE as a JSON array.` },
    ];

    let response = await llmChat(messages, { max_tokens: 2048, temperature: 0 });
    response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    console.log('[LLM Validate] Raw response:', response);

    try {
        const jsonMatch = response.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            const rejects = JSON.parse(jsonMatch[0]);
            console.log('[LLM Validate] Entities to reject:', rejects);

            const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
            const rejectSet = new Set();
            for (const r of rejects) {
                if (!r) continue;
                const txt = r.entity || r.text || r.value || r.name || '';
                if (typeof txt === 'string' && txt.trim()) {
                    rejectSet.add(normalize(txt));
                }
            }

            const kept = entities.filter(e => !rejectSet.has(normalize(e.entity)));
            const removed = entities.filter(e => rejectSet.has(normalize(e.entity)));

            console.log('[LLM Validate] Kept:', kept.length, 'Removed:', removed.length);
            if (removed.length > 0) {
                console.log('[LLM Validate] Removed false positives:', removed);
                lastDetectionBreakdown.nerFiltered.push(...removed);
            }
            return kept;
        }
    } catch (e) {
        console.warn('[LLM Validate] Parse error, keeping all entities:', e);
    }
    // On failure, keep all entities (safer for privacy)
    return entities;
}

async function extractEntitiesLLM(text, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
        { role: 'user', content: `Extract all PII entities from this medical text:\n\n${text}` },
    ];

    let response = await llmChat(messages, { max_tokens: 2048, temperature: 0 });

    // Strip thinking tags if present
    response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    try {
        const jsonMatch = response.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            const entities = JSON.parse(jsonMatch[0]);
            return entities.filter(e =>
                e && typeof e.entity === 'string' &&
                typeof e.type === 'string' &&
                e.entity.trim().length > 0
            );
        }
        return [];
    } catch (e) {
        console.warn('Entity extraction parse error:', e, 'Raw response:', response);
        return [];
    }
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

function createDetectionKey(entity, type) {
    return `${entity.trim().toLowerCase()}::${type}`;
}

function resetDetectionBreakdown(pipeline) {
    lastDetectionBreakdown = { pipeline, ner: [], llm: [], llmAdded: [], nerFiltered: [] };
    detectionSeen = {
        ner: new Set(),
        llm: new Set(),
        llmAdded: new Set(),
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

function renderDetectionTable(tableBody, entities, emptyMessage) {
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (entities.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="2">${escapeHTML(emptyMessage)}</td>`;
        tableBody.appendChild(tr);
        return;
    }

    entities
        .slice()
        .sort((a, b) => a.type.localeCompare(b.type) || a.entity.localeCompare(b.entity))
        .forEach(({ entity, type }) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(entity)}</td>
                <td><span class="entity-tag entity-tag-${type.toLowerCase()}">${type}</span></td>
            `;
            tableBody.appendChild(tr);
        });
}

function anonymizeText(text) {
    let result = text;
    const entries = Object.entries(currentMapping.entities)
        .sort((a, b) => b[0].length - a[0].length);
    for (const [entity, info] of entries) {
        const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Add Unicode-aware word boundaries to prevent replacing substrings inside words
        const prefix = /[\p{L}\p{N}]/u.test(entity.charAt(0)) ? '(?<![\\p{L}\\p{N}])' : '';
        const suffix = /[\p{L}\p{N}]/u.test(entity.charAt(entity.length - 1)) ? '(?![\\p{L}\\p{N}])' : '';
        const regex = new RegExp(prefix + escaped + suffix, 'giu');
        result = result.replace(regex, info.replacement);
    }
    return result;
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

// ── Text Chunking ──────────────────────────────────────────────────────────────
function splitLongTextSegment(segment, maxChars) {
    const chunks = [];
    let remaining = segment.trim();
    while (remaining.length > maxChars) {
        const windowText = remaining.slice(0, maxChars + 1);
        const sentenceBreak = Math.max(
            windowText.lastIndexOf('. '),
            windowText.lastIndexOf('! '),
            windowText.lastIndexOf('? '),
            windowText.lastIndexOf('; ')
        );
        const lineBreak = windowText.lastIndexOf('\n');
        const spaceBreak = windowText.lastIndexOf(' ');
        let splitAt = Math.max(sentenceBreak > maxChars * 0.45 ? sentenceBreak + 1 : -1, lineBreak, spaceBreak);
        if (splitAt < maxChars * 0.35) splitAt = maxChars;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function chunkText(text, maxChars = DEFAULT_MAX_CHUNK_CHARS) {
    const paragraphs = text.split(/\n+/);
    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
        if (!para.trim()) continue;
        if (para.length > maxChars) {
            if (current.trim()) {
                chunks.push(current.trim());
                current = '';
            }
            chunks.push(...splitLongTextSegment(para, maxChars));
            continue;
        }
        if ((current + '\n' + para).length > maxChars && current.length > 0) {
            chunks.push(current.trim());
            current = para;
        } else {
            current += (current ? '\n' : '') + para;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}

function getChunkSizeForPipeline(pipeline) {
    return isOpenAIPrivacyHybrid(pipeline) ? LOW_MEMORY_MAX_CHUNK_CHARS : DEFAULT_MAX_CHUNK_CHARS;
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
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
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
function getSelectedPipeline() {
    return anonPipelineSelect ? anonPipelineSelect.value : 'llm';
}

function updatePipelineControls() {
    const pipeline = getSelectedPipeline();
    if (anonModelSelect) {
        anonModelSelect.disabled = pipeline === 'ner';
    }
    // Hide LLM model picker when running NER-only.
    const llmGroup = document.getElementById('anonLlmModelGroup');
    if (llmGroup) llmGroup.style.display = pipeline === 'ner' ? 'none' : '';
    // Hide NER model picker, GLiNER threshold and NER hint when running LLM-only.
    const nerVisible = pipeline !== 'llm';
    const nerGroup = document.getElementById('anonNerModelGroup');
    if (nerGroup) nerGroup.style.display = nerVisible ? '' : 'none';
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
}

// ── Main Anonymization Flow ────────────────────────────────────────────────────
async function performAnonymization() {
    if (isAnonymizing || !anonDocument) return;
    isAnonymizing = true;
    anonymizeBtn.disabled = true;
    if (anonModelSelect) anonModelSelect.disabled = true;
    if (anonPipelineSelect) anonPipelineSelect.disabled = true;
    if (anonNerModelSelect) anonNerModelSelect.disabled = true;
    anonResults.style.display = 'none';
    anonProgress.style.display = 'block';
    anonProgressBar.style.width = '0%';
    startResourceMonitor();

    const pipeline = getSelectedPipeline();
    let effectivePipeline = pipeline;
    resetDetectionBreakdown(pipeline);

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
        anonProgressText.textContent = 'Error: ' + error.message;
        updateStatus('idle', 'Anonymization failed');
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
        anonProgress.style.display = 'none';
        setResourceStage('Idle', 0, 'No model running');
        stopResourceMonitor();
        updateStatus('idle', 'System Ready');
    }
}

async function anonymizeTextDocument(pipeline) {
    const text = await extractTextFromDocument(anonDocument);
    anonSourceText = text;
    const chunks = chunkText(text, getChunkSizeForPipeline(pipeline));
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
    const chunks = chunkText(allText, getChunkSizeForPipeline(pipeline));
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

    const newData = [jsonData[0]];
    for (const row of dataRows) {
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

    anonymizedResult = newWorkbook;
    anonProgressBar.style.width = '100%';
    anonProgressText.textContent = 'Anonymization complete ✓';
    return pipeline;
}

// ── Results Rendering ──────────────────────────────────────────────────────────
function renderResults() {
    anonResults.style.display = 'block';

    if (anonDetectionSummary) {
        const pipelineLabels = {
            'ner+llm': 'NER + LLM',
            ner: 'NER only',
            llm: 'LLM only',
        };
        const activeNerOption = getNERModelOption(getSelectedNerModelId());
        const activeLoadLabel = getActiveNERLoadLabel();
        const modelLabel = activeLoadLabel
            ? `${activeNerOption.label} (${activeLoadLabel})`
            : activeNerOption.label;
        const filteredNote = lastDetectionBreakdown.nerFiltered.length > 0
            ? ` LLM filtered ${lastDetectionBreakdown.nerFiltered.length} NER false positives.`
            : '';
        anonDetectionSummary.textContent = `${pipelineLabels[lastDetectionBreakdown.pipeline] || lastDetectionBreakdown.pipeline} used. Active NER model: ${modelLabel}. NER found ${lastDetectionBreakdown.ner.length} unique entities.${filteredNote} LLM found ${lastDetectionBreakdown.llm.length} unique entities. LLM added ${lastDetectionBreakdown.llmAdded.length} entities beyond NER.`;
    }
    renderDetectionTable(nerDetectionTableBody, lastDetectionBreakdown.ner, 'No NER detections for this run.');
    renderDetectionTable(llmDetectionTableBody, lastDetectionBreakdown.llm, 'No LLM detections for this run.');
    renderDetectionTable(llmAddedTableBody, lastDetectionBreakdown.llmAdded, 'No extra LLM-only detections for this run.');
    renderDetectionTable(nerFilteredTableBody, lastDetectionBreakdown.nerFiltered, 'No false positives filtered.');
    if (llmAddedSection) {
        llmAddedSection.style.display = lastDetectionBreakdown.pipeline === 'ner+llm' ? 'block' : 'none';
    }
    if (nerFilteredSection) {
        nerFilteredSection.style.display = (lastDetectionBreakdown.pipeline === 'ner+llm' && lastDetectionBreakdown.nerFiltered.length > 0) ? 'block' : 'none';
    }

    mappingTableBody.innerHTML = '';
    const entries = Object.entries(currentMapping.entities).sort((a, b) => a[1].type.localeCompare(b[1].type));
    for (const [entity, info] of entries) {
        const tr = document.createElement('tr');
        const isManual = manualEntities.has(entity);
        if (isManual) tr.className = 'is-manual';
        tr.innerHTML = `
            <td>${escapeHTML(entity)}</td>
            <td><span class="entity-tag entity-tag-${info.type.toLowerCase()}">${info.type}</span></td>
            <td class="mapping-replacement-cell" data-entity="${escapeHTML(entity)}" title="Click to edit. Set to an existing tag (e.g. [PERSON_1]) to merge."><code>${escapeHTML(info.replacement)}</code></td>
            <td><button type="button" class="mapping-delete-btn" data-entity="${escapeHTML(entity)}" title="Remove and re-apply">✕</button></td>
        `;
        mappingTableBody.appendChild(tr);
    }

    // Refresh autocomplete + popover alias picker with the unique replacements
    refreshReplacementChoices();

    if (typeof anonymizedResult === 'string') {
        // Show the FULL anonymized text — no truncation. Container is scrollable.
        anonPreviewText.textContent = anonymizedResult;
        if (anonPreviewMeta) {
            anonPreviewMeta.textContent = `(${anonymizedResult.length.toLocaleString()} chars, ${entries.length} entities)`;
        }
    } else {
        anonPreviewText.textContent = `Excel file anonymized. ${entries.length} entities replaced across selected columns.`;
        if (anonPreviewMeta) anonPreviewMeta.textContent = '';
    }

    updateMappingCount();
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Live mapping edits (add / remove → re-apply on source text) ──────────
// Re-runs `anonymizeText()` on the saved original source so the preview and
// downloaded output instantly reflect mapping edits. Excel docs are skipped
// here — they require a full re-pass through cells (use the Anonymize button
// again after editing the mapping if you need an updated workbook).
function recomputeAnonymizedFromSource() {
    if (anonDocType === 'excel') return;
    if (typeof anonSourceText !== 'string') return;
    // Compact replacement numbers so the user never sees gaps like
    // [PERSON_1], [PERSON_3], [PERSON_5] after deletions / merges.
    renumberMapping();
    anonymizedResult = anonymizeText(anonSourceText);
    renderResults();
}

// Build the list of unique replacements currently in use (so users can pick
// one as an alias for a new/existing entity → multiple originals collapse to
// the same tag). Used by the inline add datalist and the selection popover.
function refreshReplacementChoices() {
    const seen = new Map(); // replacement → type (for display hint)
    for (const info of Object.values(currentMapping.entities)) {
        if (info && info.replacement && !seen.has(info.replacement)) {
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
    const groups = new Map(); // oldReplacement → { type, originals: [entity, ...] }
    for (const [entity, info] of Object.entries(entities)) {
        if (!info || !info.replacement) continue;
        let g = groups.get(info.replacement);
        if (!g) { g = { type: info.type, originals: [] }; groups.set(info.replacement, g); }
        g.originals.push(entity);
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
        list.sort((a, b) => a.firstAt - b.firstAt);
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
        .filter(([, info]) => info && info.type === 'PERSON')
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
        currentMapping.entities[entityRaw] = { type, replacement };
        manualEntities.add(entityRaw);
        if (mappingAddEntity) mappingAddEntity.value = '';
        if (mappingAddReplacement) mappingAddReplacement.value = '';
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
    });

    mappingAddEntity?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); mappingAddBtn.click(); }
    });
}

// Smart-bundle button: heuristic person grouping + auto-renumber
const mappingSmartBundleBtn = document.getElementById('mappingSmartBundleBtn');
if (mappingSmartBundleBtn) {
    mappingSmartBundleBtn.addEventListener('click', () => {
        const merged = smartBundlePersons();
        if (merged === 0) {
            // Still renumber in case there are gaps to close.
            recomputeAnonymizedFromSource();
            mappingSmartBundleBtn.textContent = 'Smart bundle (no merges)';
            setTimeout(() => { mappingSmartBundleBtn.textContent = 'Smart bundle'; }, 1500);
            return;
        }
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
        mappingSmartBundleBtn.textContent = `Smart bundle (−${merged})`;
        setTimeout(() => { mappingSmartBundleBtn.textContent = 'Smart bundle'; }, 1500);
    });
}

// Renumber-only button: just compact the numbers, no merging.
const mappingRenumberBtn = document.getElementById('mappingRenumberBtn');
if (mappingRenumberBtn) {
    mappingRenumberBtn.addEventListener('click', () => {
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
    });
}

if (mappingTableBody) {
    mappingTableBody.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.mapping-delete-btn');
        if (delBtn) {
            const entity = delBtn.getAttribute('data-entity');
            if (!entity || !currentMapping.entities[entity]) return;
            delete currentMapping.entities[entity];
            manualEntities.delete(entity);
            recomputeAnonymizedFromSource();
            if (anonDocType === 'excel') renderResults();
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
        // If the new replacement matches an existing group, adopt that group's type.
        const aliasedType = typeForReplacement(newRep);
        currentMapping.entities[entity].replacement = newRep;
        if (aliasedType) currentMapping.entities[entity].type = aliasedType;
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
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
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
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
        currentMapping.entities[entity] = { type, replacement };
        manualEntities.add(entity);
        aliasSelect.value = '';
        hidePopover();
        window.getSelection()?.removeAllRanges();
        recomputeAnonymizedFromSource();
        if (anonDocType === 'excel') renderResults();
    });
})();

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
            const detected = Object.keys(currentMapping.entities || {});
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
                alert('Burn-in redaction failed: ' + (err && err.message ? err.message : err));
            } finally {
                downloadAnonDocBtn.disabled = false;
                downloadAnonDocBtn.innerHTML = origLabel;
            }
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
        const entries = Object.entries(currentMapping.entities).sort((a, b) => a[1].type.localeCompare(b[1].type));
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
        updateModeBanner();
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
    clearAll: async () => {
        anonDocument = null;
        anonDocType = null;
        anonWorkbook = null;
        anonymizedResult = null;
        currentMapping = { version: 1, entities: {}, counters: {} };
        resetDetectionBreakdown(getSelectedPipeline());
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
