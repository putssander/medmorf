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
} from './privacy-runtime.js?v=2026-03-24-cachefix-9';

const DEFAULT_MODEL = 'Qwen3-4B-q4f16_1-MLC';
const MAX_CHUNK_CHARS = 1500;

const LLM_MODEL_OPTIONS = {
    'Qwen3-0.6B-q4f16_1-MLC': {
        label: 'Qwen3 0.6B',
        size: '~1.4 GB',
        note: 'Smallest & fastest. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-1.7B-q4f16_1-MLC': {
        label: 'Qwen3 1.7B',
        size: '~2 GB',
        note: 'Good balance of speed and quality. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-4B-q4f16_1-MLC': {
        label: 'Qwen3 4B',
        size: '~3.4 GB',
        note: 'Best quality. Requires WebGPU.',
        engine: 'webllm',
    },
    'Qwen3-8B-q4f16_1-MLC': {
        label: 'Qwen3 8B',
        size: '~5.7 GB',
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
const downloadAnonDocBtn = document.getElementById('downloadAnonDocBtn');
const downloadMappingBtn = document.getElementById('downloadMappingBtn');
const anonWebGPUStatus = document.getElementById('anonWebGPUStatus');
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

const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');

function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// ── WebGPU Detection ───────────────────────────────────────────────────────────
let hasWebGPU = false;
(async function checkWebGPU() {
    if (!anonWebGPUStatus) return;
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                hasWebGPU = true;
                anonWebGPUStatus.innerHTML = '✓ WebGPU available';
                anonWebGPUStatus.className = 'webgpu-status supported';
            } else {
                anonWebGPUStatus.innerHTML = '⚠ WebGPU adapter not found — LLM anonymization requires WebGPU (Chrome/Edge 113+ or Safari 18+)';
                anonWebGPUStatus.className = 'webgpu-status fallback';
            }
        } catch {
            anonWebGPUStatus.innerHTML = '⚠ WebGPU error — LLM anonymization requires WebGPU';
            anonWebGPUStatus.className = 'webgpu-status fallback';
        }
    } else {
        anonWebGPUStatus.innerHTML = '⚠ No WebGPU — LLM anonymization requires WebGPU (Chrome/Edge 113+ or Safari 18+)';
        anonWebGPUStatus.className = 'webgpu-status fallback';
    }
    populateLLMModelSelect();
})();

function populateLLMModelSelect() {
    if (!anonModelSelect) return;
    anonModelSelect.innerHTML = '';
    for (const [id, opt] of Object.entries(LLM_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        el.textContent = `${opt.label} (${opt.size})`;
        if (id === DEFAULT_MODEL) el.selected = true;
        anonModelSelect.appendChild(el);
    }
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

    isAnonModelLoading = true;

    anonModelStatus.style.display = 'block';
    anonModelProgress.style.width = '0%';

    const modelOption = getSelectedLLMOption();
    const modelLabel = modelOption.label;
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

            const { CreateMLCEngine } = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.82/lib/index.js');
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
}

async function disposeAnonModel() {
    if (!engine) {
        loadedModelId = null;
        return;
    }

    const oldEngine = engine;
    engine = null;
    loadedModelId = null;

    if (typeof oldEngine.unload === 'function') {
        await oldEngine.unload();
    }
}

async function llmChat(messages, options = {}) {
    if (!engine) throw new Error('LLM engine not loaded');

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

async function initNerModel() {
    const selectedNerModelId = getSelectedNerModelId();
    const loadedNerModelId = getActiveNERModelId();
    if (getNERPipeline() && loadedNerModelId === selectedNerModelId) return;
    if (isNerLoading) return;
    isNerLoading = true;

    anonModelStatus.style.display = 'block';
    anonModelProgress.style.width = '0%';

    const anonModelHeading = document.getElementById('anonModelHeading');
    const nerOption = getNERModelOption(selectedNerModelId);
    if (anonModelHeading) anonModelHeading.textContent = `Loading ${nerOption.label}...`;
    anonModelStatusText.textContent = `Downloading ${nerOption.label}...`;
    updateStatus('loading', `Loading ${nerOption.label}...`);

    try {
        await initNERPipeline({
            modelId: selectedNerModelId,
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
        anonModelStatusText.textContent = 'NER error: ' + error.message;
        updateStatus('idle', 'NER model loading failed');
        throw error;
    } finally {
        isNerLoading = false;
    }
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
function chunkText(text) {
    const paragraphs = text.split(/\n+/);
    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
        if ((current + '\n' + para).length > MAX_CHUNK_CHARS && current.length > 0) {
            chunks.push(current.trim());
            current = para;
        } else {
            current += (current ? '\n' : '') + para;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}

// ── Document Extraction ────────────────────────────────────────────────────────
async function extractTextFromDocument(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    if (extension === 'txt') {
        return await file.text();
    } else if (extension === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value;
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

    const pipeline = getSelectedPipeline();
    let effectivePipeline = pipeline;
    resetDetectionBreakdown(pipeline);

    try {
        // Load models based on pipeline
        if (pipeline === 'ner+llm') {
            anonProgressText.textContent = 'Loading NER model...';
            updateStatus('loading', 'Loading NER model...');
            await initNerModel();
            anonProgressText.textContent = 'Loading LLM model...';
            updateStatus('loading', 'Loading LLM model...');
            try {
                await initAnonModel();
            } catch (llmError) {
                console.warn('LLM model failed to load, falling back to NER-only:', llmError.message);
                anonProgressText.textContent = 'LLM unavailable — using NER only...';
                effectivePipeline = 'ner';
            }
        } else if (pipeline === 'ner') {
            anonProgressText.textContent = 'Loading NER model...';
            updateStatus('loading', 'Loading NER model...');
            await initNerModel();
        } else {
            anonProgressText.textContent = 'Loading LLM model...';
            updateStatus('loading', 'Loading LLM model...');
            await initAnonModel();
        }

        if (anonDocType === 'excel') {
            await anonymizeExcel(effectivePipeline);
        } else {
            await anonymizeTextDocument(effectivePipeline);
        }

        renderResults();
    } catch (error) {
        console.error('Anonymization error:', error);
        anonProgressText.textContent = 'Error: ' + error.message;
        updateStatus('idle', 'Anonymization failed');
    } finally {
        isAnonymizing = false;
        anonymizeBtn.disabled = false;
        if (anonModelSelect) anonModelSelect.disabled = false;
        if (anonPipelineSelect) anonPipelineSelect.disabled = false;
        if (anonNerModelSelect) anonNerModelSelect.disabled = false;
        anonProgress.style.display = 'none';
        updateStatus('idle', 'System Ready');
    }
}

async function anonymizeTextDocument(pipeline) {
    const text = await extractTextFromDocument(anonDocument);
    const chunks = chunkText(text);
    const totalChunks = chunks.length;

    updateStatus('translating', 'Extracting PII entities...');

    if (pipeline === 'ner+llm') {
        // Phase 1: NER pass
        anonProgressText.textContent = 'NER pass: extracting entities...';
        const nerChunkResults = [];
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            nerChunkResults.push(nerEntities);
        }

        // Phase 2: LLM validation — filter NER false positives
        anonProgressText.textContent = 'LLM validation: filtering false positives...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 20 + Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM validation: chunk ${i + 1}/${totalChunks}`;
            const validated = await validateEntitiesWithLLM(nerChunkResults[i], chunks[i]);
            recordDetectedEntities('ner', validated);
            for (const { entity, type } of validated) {
                getOrCreateReplacement(entity, type);
            }
        }

        // Phase 3: LLM discovery — find additional PII the NER missed
        anonProgressText.textContent = 'LLM pass: finding remaining PII...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 40 + Math.round(((i + 1) / totalChunks) * 35);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
            const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', llmEntities);
            for (const { entity, type } of llmEntities) {
                getOrCreateReplacement(entity, type);
            }
        }
    } else if (pipeline === 'ner') {
        anonProgressText.textContent = 'NER pass: extracting entities...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            recordDetectedEntities('ner', nerEntities);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
        }
    } else {
        // LLM-only mode
        anonProgressText.textContent = 'Extracting entities...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `Extracting entities: chunk ${i + 1}/${totalChunks}`;
            const entities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', entities);
            for (const { entity, type } of entities) {
                getOrCreateReplacement(entity, type);
            }
        }
    }

    anonProgressText.textContent = 'Applying anonymization...';
    anonProgressBar.style.width = '90%';
    anonymizedResult = anonymizeText(text);
    anonProgressBar.style.width = '100%';
    anonProgressText.textContent = 'Anonymization complete ✓';
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
    const chunks = chunkText(allText);
    const totalChunks = chunks.length;

    updateStatus('translating', 'Extracting PII entities...');

    if (pipeline === 'ner+llm') {
        anonProgressText.textContent = 'NER pass: extracting entities...';
        const nerChunkResults = [];
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            nerChunkResults.push(nerEntities);
        }

        anonProgressText.textContent = 'LLM validation: filtering false positives...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 20 + Math.round(((i + 1) / totalChunks) * 20);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM validation: chunk ${i + 1}/${totalChunks}`;
            const validated = await validateEntitiesWithLLM(nerChunkResults[i], chunks[i]);
            recordDetectedEntities('ner', validated);
            for (const { entity, type } of validated) {
                getOrCreateReplacement(entity, type);
            }
        }

        anonProgressText.textContent = 'LLM pass: finding remaining PII...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 40 + Math.round(((i + 1) / totalChunks) * 35);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
            const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', llmEntities);
            for (const { entity, type } of llmEntities) {
                getOrCreateReplacement(entity, type);
            }
        }
    } else if (pipeline === 'ner') {
        anonProgressText.textContent = 'NER pass: extracting entities...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            recordDetectedEntities('ner', nerEntities);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
        }
    } else {
        anonProgressText.textContent = 'Extracting entities...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 75);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `Extracting entities: chunk ${i + 1}/${totalChunks}`;
            const entities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            recordDetectedEntities('llm', entities);
            for (const { entity, type } of entities) {
                getOrCreateReplacement(entity, type);
            }
        }
    }

    anonProgressText.textContent = 'Applying anonymization...';
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
        tr.innerHTML = `
            <td>${escapeHTML(entity)}</td>
            <td><span class="entity-tag entity-tag-${info.type.toLowerCase()}">${info.type}</span></td>
            <td><code>${escapeHTML(info.replacement)}</code></td>
        `;
        mappingTableBody.appendChild(tr);
    }

    if (typeof anonymizedResult === 'string') {
        const preview = anonymizedResult.substring(0, 2000);
        anonPreviewText.textContent = preview + (anonymizedResult.length > 2000 ? '\n\n... (truncated)' : '');
    } else {
        anonPreviewText.textContent = `Excel file anonymized. ${entries.length} entities replaced across selected columns.`;
    }

    updateMappingCount();
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Downloads ──────────────────────────────────────────────────────────────────
downloadAnonDocBtn.addEventListener('click', () => {
    if (!anonymizedResult || !anonDocument) return;
    const baseName = anonDocument.name.replace(/\.[^/.]+$/, '');
    if (typeof anonymizedResult === 'string') {
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
    if (!['xlsx', 'docx', 'txt'].includes(ext)) {
        alert('Unsupported file type. Please upload .xlsx, .docx, or .txt files.');
        return;
    }
    anonDocument = file;
    anonDocType = ext === 'xlsx' ? 'excel' : 'text';
    anonDocName.textContent = file.name;
    anonDocInfo.style.display = 'block';
    anonResults.style.display = 'none';
    anonymizedResult = null;

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
        updateNerModelHint();
        if (getNERPipeline()) {
            await disposeNERPipeline();
        }
    });
}

if (glinerThresholdInput) {
    glinerThresholdInput.addEventListener('input', () => {
        if (glinerThresholdValue) {
            glinerThresholdValue.textContent = glinerThresholdInput.value;
        }
    });
}

if (anonPipelineSelect) {
    anonPipelineSelect.addEventListener('change', updatePipelineControls);
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
populateNerModelSelect();
updatePipelineControls();
updateMappingCount();
console.log('[ANONYMIZE] Anonymization module loaded');
console.log('[ANONYMIZE] Default model:', DEFAULT_MODEL);
