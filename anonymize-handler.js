// Medical Data Anonymization — Hybrid NER + LLM pipeline
// NER: ai4privacy multilingual PII detector (ModernBERT, transformers.js v3)
// LLM: Qwen2.5 (WebLLM/WebGPU) for additional PII verification
// Zero data leaves the browser — all processing is local
//
// Model libraries are loaded lazily via dynamic import() when
// anonymization features are actually used, to avoid downloading
// large models at page load.

const DEFAULT_MODEL = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';
const NER_MODEL = 'onnx-community/llama-ai4privacy-multilingual-categorical-anonymiser-openpii-ONNX';
const MAX_CHUNK_CHARS = 1500;

// ── State ──────────────────────────────────────────────────────────────────────
let engine = null;
let loadedModelId = null;
let nerPipeline = null;
let isNerLoading = false;
let currentMapping = { version: 1, entities: {}, counters: {} };
let anonDocument = null;
let anonDocType = null;
let anonWorkbook = null;
let anonymizedResult = null;
let isAnonModelLoading = false;
let isAnonymizing = false;

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
const anonPreviewText = document.getElementById('anonPreviewText');
const downloadAnonDocBtn = document.getElementById('downloadAnonDocBtn');
const downloadMappingBtn = document.getElementById('downloadMappingBtn');
const anonWebGPUStatus = document.getElementById('anonWebGPUStatus');
const anonMappingCount = document.getElementById('anonMappingCount');
const clearAnonMappingBtn = document.getElementById('clearAnonMappingBtn');
const anonModelSelect = document.getElementById('anonModelSelect');
const anonPipelineSelect = document.getElementById('anonPipelineSelect');
const mappingExportFormat = document.getElementById('mappingExportFormat');

const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');

function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// ── WebGPU Detection ───────────────────────────────────────────────────────────
(async function checkWebGPU() {
    if (!anonWebGPUStatus) return;
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                anonWebGPUStatus.innerHTML = '✓ WebGPU available — optimal performance';
                anonWebGPUStatus.className = 'webgpu-status supported';
            } else {
                anonWebGPUStatus.innerHTML = '✗ WebGPU adapter not found — WebGPU is required for LLM anonymization';
                anonWebGPUStatus.className = 'webgpu-status fallback';
            }
        } catch {
            anonWebGPUStatus.innerHTML = '✗ WebGPU error — WebGPU is required for LLM anonymization';
            anonWebGPUStatus.className = 'webgpu-status fallback';
        }
    } else {
        anonWebGPUStatus.innerHTML = '✗ WebGPU not supported — please use Chrome/Edge 113+ or Safari 18+';
        anonWebGPUStatus.className = 'webgpu-status fallback';
    }
})();

// ── Model Loading (WebLLM / MLC Engine) ────────────────────────────────────────
function getSelectedModel() {
    return anonModelSelect ? anonModelSelect.value : DEFAULT_MODEL;
}

async function initAnonModel() {
    const selectedModel = getSelectedModel();
    if (engine && loadedModelId === selectedModel) return;
    if (isAnonModelLoading) return;

    // If switching models, reset engine
    if (engine && loadedModelId !== selectedModel) {
        engine = null;
        loadedModelId = null;
    }

    isAnonModelLoading = true;

    anonModelStatus.style.display = 'block';
    anonModelProgress.style.width = '0%';

    // Update the heading to reflect the actual model being loaded
    const modelLabel = anonModelSelect ? anonModelSelect.options[anonModelSelect.selectedIndex].text : selectedModel;
    const anonModelHeading = document.getElementById('anonModelHeading');
    if (anonModelHeading) anonModelHeading.textContent = `Loading ${modelLabel}...`;

    anonModelStatusText.textContent = `Initializing ${modelLabel}...`;
    updateStatus('loading', `Loading ${modelLabel}...`);

    try {
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

        anonModelStatusText.textContent = 'Anonymization model loaded ✓';
        anonModelProgress.style.width = '100%';
        loadedModelId = selectedModel;
        updateStatus('idle', 'System Ready');
        setTimeout(() => { anonModelStatus.style.display = 'none'; }, 2000);
    } catch (error) {
        console.error('Anonymization model loading error:', error);
        anonModelStatusText.textContent = 'Error: ' + error.message;
        updateStatus('idle', 'Model loading failed');
        engine = null;
        throw error;
    } finally {
        isAnonModelLoading = false;
    }
}

// ── LLM Entity Extraction (OpenAI-compatible chat API via WebLLM) ──────────────
// NER type mapping: ai4privacy model uses fine-grained PII labels
const NER_TYPE_MAP = {
    GIVENNAME: 'PERSON',
    SURNAME: 'PERSON',
    FIRSTNAME: 'PERSON',
    LASTNAME: 'PERSON',
    MIDDLENAME: 'PERSON',
    FULLNAME: 'PERSON',
    EMAIL: 'EMAIL',
    TELEPHONENUM: 'PHONE',
    DATE: 'DATE',
    TIME: 'DATE',
    CITY: 'LOCATION',
    STREET: 'ADDRESS',
    BUILDINGNUM: 'ADDRESS',
    ZIPCODE: 'ADDRESS',
    STATE: 'LOCATION',
    COUNTY: 'LOCATION',
    COUNTRY: 'LOCATION',
    AGE: 'AGE',
    SEX: 'OTHER',
    GENDER: 'OTHER',
    TITLE: 'OTHER',
    SOCIALNUM: 'ID_NUMBER',
    IDCARDNUM: 'ID_NUMBER',
    PASSPORTNUM: 'ID_NUMBER',
    DRIVERLICENSENUM: 'ID_NUMBER',
    CREDITCARDNUMBER: 'ID_NUMBER',
    TAXNUM: 'ID_NUMBER',
    ACCOUNTNUM: 'ID_NUMBER',
    IBAN: 'ID_NUMBER',
    IPV4: 'OTHER',
    IPV6: 'OTHER',
    USERNAME: 'OTHER',
    URL: 'OTHER',
    PER: 'PERSON',
    LOC: 'LOCATION',
    ORG: 'ORGANIZATION',
};

async function initNerModel() {
    if (nerPipeline) return;
    if (isNerLoading) return;
    isNerLoading = true;

    anonModelStatus.style.display = 'block';
    anonModelProgress.style.width = '0%';

    const anonModelHeading = document.getElementById('anonModelHeading');
    if (anonModelHeading) anonModelHeading.textContent = 'Loading NER model...';
    anonModelStatusText.textContent = 'Downloading NER model...';
    updateStatus('loading', 'Loading NER model...');

    try {
        const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
        }

        nerPipeline = await createPipeline('token-classification', NER_MODEL, {
            dtype: 'q8',
            progress_callback: (progress) => {
                if (progress.status === 'progress' && progress.total > 0) {
                    const pct = Math.round((progress.loaded / progress.total) * 100);
                    anonModelProgress.style.width = pct + '%';
                    anonModelStatusText.textContent = `Downloading NER model: ${pct}%`;
                }
            },
        });

        anonModelStatusText.textContent = 'NER model loaded ✓';
        anonModelProgress.style.width = '100%';
        updateStatus('idle', 'NER model ready');
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
    const results = await nerPipeline(text, { aggregation_strategy: 'simple' });
    console.log('[NER] Raw output for chunk:', results);
    const entities = [];
    for (const r of results) {
        // Strip B-/I- prefix from entity_group (e.g. "B-PER" → "PER")
        const rawType = (r.entity_group || r.entity || '').replace(/^[BI]-/, '');
        const type = NER_TYPE_MAP[rawType] || rawType;
        const word = r.word?.trim();
        const score = r.score || 0;
        if (word && word.length > 1 && type && score > 0.3) {
            entities.push({ entity: word, type });
        }
    }
    console.log('[NER] Mapped entities:', entities);
    return entities;
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

async function extractEntitiesLLM(text, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
        { role: 'user', content: `Extract all PII entities from this medical text:\n\n${text}` },
    ];

    const reply = await engine.chat.completions.create({
        messages,
        max_tokens: 2048,
        temperature: 0,
    });

    let response = reply.choices[0].message.content || '';

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

function anonymizeText(text) {
    let result = text;
    const entries = Object.entries(currentMapping.entities)
        .sort((a, b) => b[0].length - a[0].length);
    for (const [entity, info] of entries) {
        const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
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
    return anonPipelineSelect ? anonPipelineSelect.value : 'ner+llm';
}

// ── Main Anonymization Flow ────────────────────────────────────────────────────
async function performAnonymization() {
    if (isAnonymizing || !anonDocument) return;
    isAnonymizing = true;
    anonymizeBtn.disabled = true;
    if (anonModelSelect) anonModelSelect.disabled = true;
    if (anonPipelineSelect) anonPipelineSelect.disabled = true;
    anonResults.style.display = 'none';
    anonProgress.style.display = 'block';
    anonProgressBar.style.width = '0%';

    const pipeline = getSelectedPipeline();

    try {
        // Load models based on pipeline
        if (pipeline === 'ner+llm') {
            anonProgressText.textContent = 'Loading NER model...';
            updateStatus('loading', 'Loading NER model...');
            await initNerModel();
            anonProgressText.textContent = 'Loading LLM model...';
            updateStatus('loading', 'Loading LLM model...');
            await initAnonModel();
        } else {
            anonProgressText.textContent = 'Loading LLM model...';
            updateStatus('loading', 'Loading LLM model...');
            await initAnonModel();
        }

        if (anonDocType === 'excel') {
            await anonymizeExcel(pipeline);
        } else {
            await anonymizeTextDocument(pipeline);
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
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 25);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
        }

        // Phase 2: LLM verification pass. Use the full prompt for higher recall;
        // duplicates are deduplicated by the mapping layer.
        anonProgressText.textContent = 'LLM pass: finding remaining PII...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 25 + Math.round(((i + 1) / totalChunks) * 50);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
            const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            for (const { entity, type } of llmEntities) {
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
        for (let i = 0; i < totalChunks; i++) {
            const pct = Math.round(((i + 1) / totalChunks) * 25);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `NER pass: chunk ${i + 1}/${totalChunks}`;
            const nerEntities = await extractEntitiesNER(chunks[i]);
            for (const { entity, type } of nerEntities) {
                getOrCreateReplacement(entity, type);
            }
        }

        anonProgressText.textContent = 'LLM pass: finding remaining PII...';
        for (let i = 0; i < totalChunks; i++) {
            const pct = 25 + Math.round(((i + 1) / totalChunks) * 50);
            anonProgressBar.style.width = pct + '%';
            anonProgressText.textContent = `LLM pass: chunk ${i + 1}/${totalChunks}`;
            const llmEntities = await extractEntitiesLLM(chunks[i], SYSTEM_PROMPT);
            for (const { entity, type } of llmEntities) {
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

anonymizeBtn.addEventListener('click', () => performAnonymization());

// Expose in-memory data status for the Storage tab
window.medmorfAnonymizeData = {
    hasDocument: () => anonDocument !== null,
    documentName: () => anonDocument ? anonDocument.name : null,
    hasResult: () => anonymizedResult !== null,
    hasMapping: () => Object.keys(currentMapping.entities).length > 0,
    mappingCount: () => Object.keys(currentMapping.entities).length,
    clearAll: () => {
        anonDocument = null;
        anonDocType = null;
        anonWorkbook = null;
        anonymizedResult = null;
        currentMapping = { version: 1, entities: {}, counters: {} };
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
updateMappingCount();
console.log('[ANONYMIZE] Anonymization module loaded');
console.log('[ANONYMIZE] Default model:', DEFAULT_MODEL);
