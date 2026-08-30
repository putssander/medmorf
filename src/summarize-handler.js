// Medical Document Summarization — LLM-powered structured report generation
// Uses the same Qwen3.5 models available for anonymization (WebLLM/WebGPU).
// Templates guide the LLM to fill in specific report sections.
// Zero data leaves the browser — all processing is local.

import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-08-30-memory-bar-2';
import { getCapabilities, recommendDefault } from './device-capabilities.js?v=2026-05-28-resource-1';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';

const BUILD_ID = window.MEDMORF_BUILD_ID || 'unknown-build';
console.log('[BUILD] summarize-handler.js build', BUILD_ID, 'module url', import.meta.url);


// ── Templates ──────────────────────────────────────────────────────────────────
const SUMMARIZE_TEMPLATES = {
    psychology: {
        id: 'psychology',
        label: 'Psychologisch Verslag',
        language: 'nl',
        description: 'Psychologisch verslag met kernonderdelen volgens standaard GGZ structuur.',
        sections: [
            {
                key: 'klachtenomschrijving',
                title: '1. Klachtenomschrijving',
                hints: 'Huidige klachten (aard, ernst, duur). Aanleiding van hulpvraag. Eventuele triggers.',
            },
            {
                key: 'dsm_classificatie',
                title: '2. DSM-classificatie',
                hints: '(Voorlopige) diagnose volgens DSM. Eventuele differentiaaldiagnoses.',
            },
            {
                key: 'luxerende_factoren',
                title: '3. Luxerende factoren',
                hints: 'Uitlokkende gebeurtenissen (recent). Stressoren (werk, relaties, verlies, etc.).',
            },
            {
                key: 'persoonlijkheid',
                title: '4. Persoonlijkheid',
                hints: 'Kenmerkende trekken. Eventuele persoonlijkheidsproblematiek.',
            },
            {
                key: 'coping',
                title: '5. Coping',
                hints: 'Omgaan met stress/emoties. Adaptieve vs. maladaptieve strategieën.',
            },
            {
                key: 'leergeschiedenis',
                title: '6. Leergeschiedenis',
                hints: 'Opvoeding en ontwikkeling. Belangrijke ervaringen (bijv. trauma, hechting).',
            },
            {
                key: 'hulpverleningsgeschiedenis',
                title: '7. Hulpverleningsgeschiedenis',
                hints: 'Eerdere behandelingen. Effect en verloop van therapieën.',
            },
            {
                key: 'medicatie',
                title: '8. Medicatie',
                hints: 'Huidig gebruik. Eerdere medicatie en effect.',
            },
        ],
    },
    soap: {
        id: 'soap',
        label: 'SOAP Note',
        language: 'en',
        description: 'Standard SOAP note format for clinical documentation.',
        sections: [
            {
                key: 'subjective',
                title: 'Subjective',
                hints: 'Patient\'s reported symptoms, complaints, history. What the patient says.',
            },
            {
                key: 'objective',
                title: 'Objective',
                hints: 'Clinical observations, examination findings, vital signs, test results.',
            },
            {
                key: 'assessment',
                title: 'Assessment',
                hints: 'Clinical assessment, diagnosis, differential diagnoses.',
            },
            {
                key: 'plan',
                title: 'Plan',
                hints: 'Treatment plan, medications, referrals, follow-up.',
            },
        ],
    },
    freeform: {
        id: 'freeform',
        label: 'Free-form Summary',
        language: 'en',
        description: 'Unstructured summary of the document content.',
        sections: [
            {
                key: 'summary',
                title: 'Summary',
                hints: 'Provide a comprehensive summary of the document.',
            },
        ],
    },
};

// ── LLM Model Options (shared with anonymize-handler) ──────────────────────────
const DEFAULT_MODEL = 'Qwen3.5-2B-q4f16_1-MLC';

const LLM_MODEL_OPTIONS = {
    'Qwen3.5-0.8B-q4f16_1-MLC': {
        label: 'Qwen3.5 0.8B',
        size: '~1.6 GB',
        sizeMB: 1630,
        note: 'Newer generation, small. Good summaries in benchmarks (86% fact coverage). Requires WebGPU.',
    },
    'Qwen3.5-2B-q4f16_1-MLC': {
        label: 'Qwen3.5 2B',
        size: '~2.2 GB',
        sizeMB: 2250,
        note: 'Best PII recall under 3 GB in benchmarks (83% vs 52% for Qwen3 1.7B). Requires WebGPU.',
    },
    'Qwen3.5-4B-q4f16_1-MLC': {
        label: 'Qwen3.5 4B',
        size: '~3.9 GB',
        sizeMB: 3870,
        note: 'Largest browser-feasible option; needs ~4 GB GPU memory. Requires WebGPU.',
    },
};

// ── State ──────────────────────────────────────────────────────────────────────
let engine = null;
let loadedModelId = null;
let isModelLoading = false;
let isSummarizing = false;
let summarizeDocument = null;
let summarizeResult = null;

// ── DOM Elements ───────────────────────────────────────────────────────────────
const sumDocUpload = document.getElementById('sumDocUpload');
const sumDocInput = document.getElementById('sumDocInput');
const sumDocInfo = document.getElementById('sumDocInfo');
const sumDocName = document.getElementById('sumDocName');
const sumTemplateSelect = document.getElementById('sumTemplateSelect');
const sumModelSelect = document.getElementById('sumModelSelect');
const sumTemplateDesc = document.getElementById('sumTemplateDesc');
const sumModelStatus = document.getElementById('sumModelStatus');
const sumModelProgress = document.getElementById('sumModelProgress');
const sumModelStatusText = document.getElementById('sumModelStatusText');
const sumProgress = document.getElementById('sumProgress');
const sumProgressBar = document.getElementById('sumProgressBar');
const sumProgressText = document.getElementById('sumProgressText');
const summarizeBtn = document.getElementById('summarizeBtn');
const sumResults = document.getElementById('sumResults');
const sumOutputText = document.getElementById('sumOutputText');
const downloadSumBtn = document.getElementById('downloadSumBtn');
const sumWebGPUStatus = document.getElementById('sumWebGPUStatus');
const sumInputText = document.getElementById('sumInputText');
const sumInputSection = document.getElementById('sumInputSection');

const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');

function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// iPhone/iPad: WebKit kills a tab around ~1.5 GB while the smallest WebLLM
// model needs ~1.6 GB VRAM — loading is a guaranteed crash (confirmed on an
// iPhone 17 Pro). Block with an explanation instead of crashing.
function isIosDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
const IOS_LLM_BLOCK_MSG = 'Language-model features are not available on iPhone/iPad: the smallest model needs ~1.6 GB of memory while iOS limits a browser tab to about 1.5 GB, so loading would crash the page. Use a desktop browser (Chrome/Edge recommended) for this feature.';

// ── WebGPU Detection ───────────────────────────────────────────────────────────
let hasWebGPU = false;
(async function checkWebGPU() {
    if (!sumWebGPUStatus) return;
    if (isIosDevice()) {
        sumWebGPUStatus.innerHTML = '⚠ ' + IOS_LLM_BLOCK_MSG;
        sumWebGPUStatus.className = 'webgpu-status fallback';
        if (summarizeBtn) { summarizeBtn.disabled = true; summarizeBtn.title = IOS_LLM_BLOCK_MSG; }
        return;
    }
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                hasWebGPU = true;
                sumWebGPUStatus.innerHTML = '✓ WebGPU available';
                sumWebGPUStatus.className = 'webgpu-status supported';
            } else {
                sumWebGPUStatus.innerHTML = '⚠ WebGPU adapter not found';
                sumWebGPUStatus.className = 'webgpu-status fallback';
            }
        } catch {
            sumWebGPUStatus.innerHTML = '⚠ WebGPU error';
            sumWebGPUStatus.className = 'webgpu-status fallback';
        }
    } else {
        sumWebGPUStatus.innerHTML = '⚠ No WebGPU — summarization requires WebGPU';
        sumWebGPUStatus.className = 'webgpu-status fallback';
    }
    populateModelSelect();
})();

// ── Populate Selects ───────────────────────────────────────────────────────────
function populateTemplateSelect() {
    if (!sumTemplateSelect) return;
    sumTemplateSelect.innerHTML = '';
    for (const [id, tpl] of Object.entries(SUMMARIZE_TEMPLATES)) {
        const el = document.createElement('option');
        el.value = id;
        el.textContent = tpl.label;
        if (id === 'freeform') el.selected = true;
        sumTemplateSelect.appendChild(el);
    }
    updateTemplateDescription();
}

function updateTemplateDescription() {
    if (!sumTemplateDesc) return;
    const tpl = SUMMARIZE_TEMPLATES[sumTemplateSelect.value];
    if (tpl) {
        const sectionList = tpl.sections.map(s => s.title).join(', ');
        sumTemplateDesc.textContent = `${tpl.description} Sections: ${sectionList}.`;
    }
}

function populateModelSelect() {
    if (!sumModelSelect) return;
    sumModelSelect.innerHTML = '';
    const candidates = Object.entries(LLM_MODEL_OPTIONS).map(([id, o]) => ({ id, sizeMB: o.sizeMB }));
    const recommended = recommendDefault(candidates) || DEFAULT_MODEL;
    for (const [id, opt] of Object.entries(LLM_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        el.textContent = `${opt.label} (${opt.size})`;
        if (id === recommended) el.selected = true;
        sumModelSelect.appendChild(el);
    }
}

// Re-evaluate once device probe finishes; respect manual user selection.
getCapabilities().then(() => {
    if (sumModelSelect && !sumModelSelect.dataset.userChosen) {
        populateModelSelect();
    }
});
if (sumModelSelect) {
    sumModelSelect.addEventListener('change', () => {
        sumModelSelect.dataset.userChosen = '1';
    });
}

// ── Model Loading ──────────────────────────────────────────────────────────────
function getSelectedModel() {
    return sumModelSelect ? sumModelSelect.value : DEFAULT_MODEL;
}

function formatLoadError(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}


async function initSumModel() {
    if (isIosDevice()) {
        if (sumModelStatusText) sumModelStatusText.textContent = IOS_LLM_BLOCK_MSG;
        throw new Error(IOS_LLM_BLOCK_MSG);
    }
    const selectedModel = getSelectedModel();
    if (engine && loadedModelId === selectedModel) return;
    if (isModelLoading) return;

    if (engine && loadedModelId !== selectedModel) {
        await disposeSumModel();
    }

    const modelLabel = LLM_MODEL_OPTIONS[selectedModel]?.label || selectedModel;
    const sizeMB = LLM_MODEL_OPTIONS[selectedModel]?.sizeMB || 0;

    const proceed = await preflightWarn({
        key: `llm:${selectedModel}`,
        title: 'Load summarization model?',
        model: `${modelLabel} (${selectedModel})`,
        sizeMB,
        why: 'Large LLMs need WebGPU and several GB of RAM/VRAM. On low-RAM devices the tab may crash. Pick a smaller variant if unsure.',
    });
    if (!proceed) {
        throw new Error('Model load cancelled by user');
    }

    return withHeavyLoadLock(`LLM (summarize): ${modelLabel}`, async () => {
        isModelLoading = true;
        sumModelStatus.style.display = 'block';
        sumModelProgress.style.width = '0%';

        const sumModelHeading = document.getElementById('sumModelHeading');
        if (sumModelHeading) sumModelHeading.textContent = `Loading ${modelLabel}...`;
        sumModelStatusText.textContent = `Initializing ${modelLabel}...`;
        updateStatus('loading', `Loading ${modelLabel}...`);

        try {
            // Check if model is already cached
            let modelCached = false;
            try {
                const cacheNames = await caches.keys();
                modelCached = cacheNames.some(name => {
                    const lower = name.toLowerCase();
                    return lower.includes('webllm') || lower.includes('mlc') || lower.includes('tvmjs');
                });
            } catch { /* ignore */ }

            if (!modelCached) {
                const configUrl = `https://huggingface.co/mlc-ai/${selectedModel}/resolve/main/mlc-chat-config.json`;
                try {
                    const probe = await fetch(configUrl);
                    if (!probe.ok) {
                        throw new Error(`HuggingFace returned ${probe.status} for ${selectedModel}. Check your internet connection.`);
                    }
                } catch (fetchErr) {
                    throw new Error(
                        `Cannot reach model files for ${modelLabel}. ` +
                        (fetchErr.message.includes('Failed to fetch') || fetchErr.message.includes('NetworkError') || fetchErr.message.includes('Load failed')
                            ? 'Check your internet connection.'
                            : fetchErr.message)
                    );
                }
            }

            const { CreateMLCEngine } = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/lib/index.js');
            engine = await CreateMLCEngine(selectedModel, {
                initProgressCallback: (progress) => {
                    const text = progress.text || '';
                    const pctMatch = text.match(/(\d+(?:\.\d+)?)%/);
                    if (pctMatch) {
                        sumModelProgress.style.width = pctMatch[1] + '%';
                    }
                    sumModelStatusText.textContent = text || 'Loading...';
                    updateStatus('loading', text || 'Loading summarization model...');
                },
            });

            sumModelStatusText.textContent = 'Model loaded ✓';
            sumModelProgress.style.width = '100%';
            loadedModelId = selectedModel;
            registerLoadedModel('summarize-llm', disposeSumModel, { sizeMB });
            updateStatus('idle', 'System Ready');
            setTimeout(() => { sumModelStatus.style.display = 'none'; }, 2000);
        } catch (error) {
            console.error('Summarization model loading error:', error);
            sumModelStatusText.textContent = 'Error: ' + formatLoadError(error);
            updateStatus('idle', 'Model loading failed');
            engine = null;
            throw error;
        } finally {
            isModelLoading = false;
        }
    });
}

async function disposeSumModel() {
    if (!engine) {
        loadedModelId = null;
        return;
    }
    const oldEngine = engine;
    engine = null;
    loadedModelId = null;
    unregisterLoadedModel('summarize-llm');
    if (typeof oldEngine.unload === 'function') {
        await oldEngine.unload();
    }
}

async function llmChat(messages, options = {}) {
    if (!engine) throw new Error('LLM engine not loaded');
    markModelUsed('summarize-llm');
    const reply = await engine.chat.completions.create({
        messages,
        max_tokens: options.max_tokens || 4096,
        // Qwen3 / Qwen3.5 hybrid-thinking: skip the <think> block. Prompts already
        // forbid reasoning; without this, Qwen3.5 spends the whole token budget thinking.
        extra_body: { enable_thinking: false },
        temperature: options.temperature ?? 0.3,
    });
    return reply.choices[0].message.content || '';
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
        const wb = XLSX.read(data, { type: 'array' });
        const texts = [];
        for (const sheetName of wb.SheetNames) {
            const ws = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            for (const row of rows) {
                const textCells = row.filter(c => typeof c === 'string' && c.trim());
                if (textCells.length > 0) texts.push(textCells.join(' '));
            }
        }
        return texts.join('\n');
    }
    throw new Error('Unsupported file type: ' + extension);
}

// ── Build Summary Prompt ───────────────────────────────────────────────────────
function buildSummaryPrompt(text, templateId, lang) {
    const template = SUMMARIZE_TEMPLATES[templateId];
    const langInstruction = `IMPORTANT: You MUST write the entire summary in ${lang}. All text, headings, and bullet points must be in ${lang}.`;
    if (!template) {
        return {
            system: `You are a clinical document summarization expert. Summarize the following medical document clearly and concisely. ${langInstruction}`,
            user: `Summarize this document:\n\n${text}`,
        };
    }

    const sectionInstructions = template.sections.map(s =>
        `## ${s.title}\n${s.hints}`
    ).join('\n\n');

    const system = `You are a clinical document summarization expert. Generate a structured report from the provided document.

${langInstruction} Translate section headings to ${lang} if needed. If a section has no relevant information, state that briefly.

Sections:
${sectionInstructions}

Rules:
1. Use the section headings above (translated to ${lang}).
2. Be concise but thorough. Use bullet points.
3. Only include information present in the document.
4. Do NOT invent information.
5. No markdown code blocks. Use ## for headings.
6. Do NOT output reasoning or thinking, go straight to the report.`;

    const user = `Generate the structured report from this document:\n\n${text}`;

    return { system, user };
}

// ── Chunked Summarization ──────────────────────────────────────────────────────
const CHUNK_SIZE = 3000;      // chars per chunk (≈1000-1200 tokens for Dutch)
const CHUNK_OVERLAP = 200;    // overlap to avoid cutting mid-sentence
const SINGLE_PASS_LIMIT = 6000; // docs shorter than this go single-pass

// Detect the dominant language of the source text
function detectLanguage(text) {
    // Sample first 2000 chars for common Dutch/German/French markers
    const sample = text.substring(0, 2000).toLowerCase();
    const nlWords = ['de','het','een','van','en','is','dat','voor','niet','met','op','aan','uit','maar','ook','naar','als','nog','wordt','zijn','heeft','wordt','wordt','deze','dit','bij','kan','over','werd','door','meer','wel','geen','hun','onder','na','tot'];
    const enWords = ['the','is','and','of','to','in','that','for','with','was','on','are','this','but','not','from','have','has','had','been','were','they','will','can','would','about','which','their','said','each'];
    let nlScore = 0, enScore = 0;
    for (const w of nlWords) { const re = new RegExp('\\b' + w + '\\b', 'g'); nlScore += (sample.match(re) || []).length; }
    for (const w of enWords) { const re = new RegExp('\\b' + w + '\\b', 'g'); enScore += (sample.match(re) || []).length; }
    if (nlScore > enScore * 1.2) return 'Dutch';
    if (enScore > nlScore * 1.2) return 'English';
    // Fallback: check for common Dutch digraphs
    if (/ij|oe|ui|aa|ee|oo|uu/i.test(sample)) return 'Dutch';
    return 'the same language as the source text';
}

function splitIntoChunks(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + CHUNK_SIZE, text.length);
        // Try to break at a sentence boundary
        if (end < text.length) {
            const slice = text.substring(start, end);
            const lastBreak = Math.max(slice.lastIndexOf('.\n'), slice.lastIndexOf('. '), slice.lastIndexOf('?\n'), slice.lastIndexOf('? '));
            if (lastBreak > CHUNK_SIZE * 0.5) {
                end = start + lastBreak + 1;
            }
        }
        chunks.push(text.substring(start, end).trim());
        start = end - CHUNK_OVERLAP;
        if (start < 0) start = 0;
        // Avoid infinite loop on very small remaining text
        if (end >= text.length) break;
    }
    return chunks.filter(c => c.length > 50);
}

async function extractChunkFacts(chunkText, chunkIndex, totalChunks, lang) {
    const system = `You are a clinical document analyst. Extract all clinically relevant facts from this document fragment. You MUST write in ${lang}.

Output a concise bullet-point list of key facts, observations, and details. Include: symptoms, diagnoses, timeline, medications, history, relationships, risk factors, coping strategies — anything clinically relevant.

Do NOT output reasoning or thinking. Go straight to the bullet points.`;

    const user = `Extract key clinical facts from this text (part ${chunkIndex + 1} of ${totalChunks}):\n\n${chunkText}`;

    let result = await llmChat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { max_tokens: 1500, temperature: 0.1 }
    );
    result = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return result;
}

function buildMergePrompt(extractedFacts, templateId, lang) {
    const template = SUMMARIZE_TEMPLATES[templateId];
    const langInstruction = `You MUST write the entire report in ${lang}. All text, headings, and bullet points must be in ${lang}.`;
    if (!template) {
        return {
            system: `You are a clinical document summarization expert. Synthesize the extracted facts into a clear, comprehensive summary. ${langInstruction} Do NOT output reasoning or thinking.`,
            user: `Synthesize these extracted facts into a coherent summary:\n\n${extractedFacts}`,
        };
    }

    const sectionInstructions = template.sections.map(s =>
        `## ${s.title}\n${s.hints}`
    ).join('\n\n');

    const system = `You are a clinical document summarization expert. Synthesize the extracted facts below into a structured report.

${langInstruction} Translate section headings to ${lang} if needed.

Sections:
${sectionInstructions}

Rules:
1. Use the section headings above (translated to ${lang}).
2. Be concise but thorough. Use bullet points.
3. Only include information present in the extracted facts.
4. Do NOT invent information. If a section has no relevant facts, state that briefly.
5. No markdown code blocks. Use ## for headings.
6. Do NOT output reasoning or thinking, go straight to the report.`;

    const user = `Generate the structured report from these extracted clinical facts:\n\n${extractedFacts}`;

    return { system, user };
}

// ── Main Summarization Flow ────────────────────────────────────────────────────
async function performSummarization() {
    if (isSummarizing) return;

    // Get text from either document or text input
    let text = '';
    if (summarizeDocument) {
        text = await extractTextFromDocument(summarizeDocument);
    } else if (sumInputText && sumInputText.value.trim()) {
        text = sumInputText.value.trim();
    }

    if (!text) {
        alert('Please upload a document or paste text to summarize.');
        return;
    }

    isSummarizing = true;
    summarizeBtn.disabled = true;
    if (sumModelSelect) sumModelSelect.disabled = true;
    if (sumTemplateSelect) sumTemplateSelect.disabled = true;
    sumResults.style.display = 'none';
    sumProgress.style.display = 'block';
    sumProgressBar.style.width = '0%';

    try {
        // Load model
        sumProgressText.textContent = 'Loading LLM model...';
        updateStatus('loading', 'Loading summarization model...');
        await initSumModel();

        const templateId = sumTemplateSelect ? sumTemplateSelect.value : 'freeform';
        const lang = detectLanguage(text);
        console.log(`[SUM] Detected language: ${lang}, text length: ${text.length} chars`);
        let response;

        if (text.length <= SINGLE_PASS_LIMIT) {
            // ── Single-pass for short documents ──
            sumProgressText.textContent = 'Generating summary...';
            sumProgressBar.style.width = '40%';
            updateStatus('translating', 'Generating summary...');

            const { system, user } = buildSummaryPrompt(text, templateId, lang);
            const messages = [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ];
            response = await llmChat(messages, { max_tokens: 4096, temperature: 0.3 });

        } else {
            // ── Multi-pass for long documents ──
            const chunks = splitIntoChunks(text);
            const totalChunks = chunks.length;

            // Pass 1: Extract facts from each chunk
            const allFacts = [];
            for (let i = 0; i < totalChunks; i++) {
                const pct = 20 + Math.round((i / totalChunks) * 50);
                sumProgressBar.style.width = pct + '%';
                sumProgressText.textContent = `Analyzing section ${i + 1} of ${totalChunks}...`;
                updateStatus('translating', `Analyzing section ${i + 1}/${totalChunks}...`);

                const facts = await extractChunkFacts(chunks[i], i, totalChunks, lang);
                if (facts) allFacts.push(facts);
            }

            const combinedFacts = allFacts.join('\n\n');

            // Pass 2: Merge all facts into structured report
            sumProgressBar.style.width = '80%';
            sumProgressText.textContent = 'Composing final report...';
            updateStatus('translating', 'Composing final report...');

            const { system, user } = buildMergePrompt(combinedFacts, templateId, lang);

            // If combined facts are still too long, truncate
            const maxFactChars = 3500;
            const mergeUser = combinedFacts.length > maxFactChars
                ? `Generate the structured report from these extracted clinical facts (condensed):\n\n${combinedFacts.substring(0, maxFactChars)}`
                : user;

            response = await llmChat(
                [{ role: 'system', content: system }, { role: 'user', content: mergeUser }],
                { max_tokens: 4096, temperature: 0.3 }
            );
        }

        // Strip thinking tags if present
        response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        sumProgressBar.style.width = '100%';
        sumProgressText.textContent = 'Summary complete ✓';

        summarizeResult = response;
        renderSumResults(response);
    } catch (error) {
        console.error('Summarization error:', error);
        sumProgressText.textContent = 'Error: ' + error.message;
        updateStatus('idle', 'Summarization failed');
    } finally {
        isSummarizing = false;
        summarizeBtn.disabled = false;
        if (sumModelSelect) sumModelSelect.disabled = false;
        if (sumTemplateSelect) sumTemplateSelect.disabled = false;
        sumProgress.style.display = 'none';
        updateStatus('idle', 'System Ready');
    }
}

function renderSumResults(text) {
    sumResults.style.display = 'block';
    if (sumOutputText) {
        sumOutputText.textContent = text;
    }
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Downloads ──────────────────────────────────────────────────────────────────
if (downloadSumBtn) {
    downloadSumBtn.addEventListener('click', () => {
        if (!summarizeResult) return;
        const baseName = summarizeDocument
            ? summarizeDocument.name.replace(/\.[^/.]+$/, '')
            : 'summary';
        const blob = new Blob([summarizeResult], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, `${baseName}_summary.txt`);
    });
}

// ── Copy to clipboard ──────────────────────────────────────────────────────────
const copySumBtn = document.getElementById('copySumBtn');
if (copySumBtn) {
    copySumBtn.addEventListener('click', async () => {
        if (!summarizeResult) return;
        try {
            await navigator.clipboard.writeText(summarizeResult);
            copySumBtn.textContent = '✓ Copied!';
            setTimeout(() => { copySumBtn.textContent = 'Copy'; }, 2000);
        } catch (e) {
            console.error('Copy failed:', e);
        }
    });
}

// ── Upload Handlers ────────────────────────────────────────────────────────────
function setupDropArea(area, input, onFile) {
    if (!area || !input) return;
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

setupDropArea(sumDocUpload, sumDocInput, async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'docx', 'txt'].includes(ext)) {
        alert('Unsupported file type. Please upload .xlsx, .docx, or .txt files.');
        return;
    }
    summarizeDocument = file;
    sumDocName.textContent = file.name;
    sumDocInfo.style.display = 'block';
    sumResults.style.display = 'none';
    summarizeResult = null;
    summarizeBtn.disabled = false;
});

// ── Event Listeners ────────────────────────────────────────────────────────────
if (sumTemplateSelect) {
    sumTemplateSelect.addEventListener('change', updateTemplateDescription);
}

if (summarizeBtn) {
    summarizeBtn.addEventListener('click', () => performSummarization());
}

// Enable summarize button when text is pasted
if (sumInputText) {
    sumInputText.addEventListener('input', () => {
        if (summarizeBtn) {
            summarizeBtn.disabled = !sumInputText.value.trim() && !summarizeDocument;
        }
    });
}

// Clean up when leaving the tab
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (btn.dataset.tab !== 'summarize') {
            await disposeSumModel();
        }
    });
});

// Expose in-memory data for privacy inspector
window.medmorfSummarizeData = {
    hasDocument: () => summarizeDocument !== null,
    documentName: () => summarizeDocument ? summarizeDocument.name : null,
    hasResult: () => summarizeResult !== null,
    clearAll: async () => {
        summarizeDocument = null;
        summarizeResult = null;
        await disposeSumModel();
        if (sumDocInput) sumDocInput.value = '';
        if (sumDocInfo) sumDocInfo.style.display = 'none';
        if (sumResults) sumResults.style.display = 'none';
        if (sumInputText) sumInputText.value = '';
        if (summarizeBtn) summarizeBtn.disabled = true;
        console.log('[PRIVACY] All summarization data cleared');
    },
};

// ── Init ───────────────────────────────────────────────────────────────────────
populateTemplateSelect();
console.log('[SUMMARIZE] Summarization module loaded');
