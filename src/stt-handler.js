// Offline Speech-to-Text — Whisper via Transformers.js (WebAssembly/WebGPU)
// Uses whisper-small or whisper-tiny for browser-based transcription.
// Zero data leaves the browser — all processing is local.

import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-08-30-memory-bar-2';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';
import { startSession, updateSession, appendChunk, findRecoverable, loadPCM, getSession, deleteSession, deleteAllSessions, pcmToWavBlob } from './stt-store.js?v=2026-08-30-crash-safe-1';

const BUILD_ID = window.MEDMORF_BUILD_ID || 'unknown-build';
console.log('[BUILD] stt-handler.js build', BUILD_ID, 'module url', import.meta.url);

// ── Model Options ──────────────────────────────────────────────────────────────
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Empirical iOS ceiling: whisper-small (q8+q4, ~310 MB weights) reboots the
// page on a real iPhone 17 Pro during load; base (~105 MB) is the largest
// safe tier there. Mirrors the LLM tiering in summarize-handler.
const IOS_MAX_STT_MB = 150; // compares against sizeMobileMB (q8/q4 build)
const LS_KEY_STT_MODEL = 'medmorf:stt-model';
// WASM memory grows but NEVER shrinks: after any model load the heap stays at
// peak size even after dispose(). On iOS, loading a second model on top of a
// grown heap is what pushes the page over WebKit's kill line ("memory is not
// freed"). A controlled reload is the only real reset.
let sttEverLoaded = false;
let hasWebGPU = false;

// Detect WebGPU at startup (M-series Macs, modern GPUs)
(async function detectWebGPU() {
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                hasWebGPU = true;
                console.log('[STT] WebGPU available — will use GPU acceleration');
            }
        } catch (_) {}
    }
    // Rebuild select once detection completes
    populateSTTModelSelect();
})();

// WebGPU has been the single biggest source of STT hangs (cold-start kernel
// compilation can stall for 30 s+, and the JSEP glue occasionally fails to
// expose `Module.webgpuInit`, leaving inference deadlocked). For stability
// we default to WASM on every device. Power users can opt back into WebGPU
// by appending `?stt-gpu=1` to the URL.
const STT_FORCE_WASM = !/[?&]stt-gpu=1\b/.test(typeof location !== 'undefined' ? location.search : '');
// On-device bisection flags for the iOS load-reboot bug:
//   ?stt-no-proxy=1  run ORT on the main thread (no proxy worker)
//   ?stt-no-cache=1  skip the browser Cache API for model weights
const STT_NO_PROXY = /[?&]stt-no-proxy=1\b/.test(typeof location !== 'undefined' ? location.search : '');
const STT_NO_CACHE = /[?&]stt-no-cache=1\b/.test(typeof location !== 'undefined' ? location.search : '');
const STT_NO_WARM = /[?&]stt-no-warm=1\b/.test(typeof location !== 'undefined' ? location.search : '');
// Crash breadcrumbs: persist the current load stage so that when iOS kills the
// page mid-load we can show WHERE it died on the next visit.
const LS_KEY_STT_STAGE = 'medmorf:stt-last-stage';
function stage(name) {
    try { localStorage.setItem(LS_KEY_STT_STAGE, JSON.stringify({ name, model: getSelectedModel?.() || '?', at: Date.now(), flags: { noProxy: STT_NO_PROXY, noCache: STT_NO_CACHE, noWarm: STT_NO_WARM } })); } catch (_) {}
}
function clearStage() { try { localStorage.removeItem(LS_KEY_STT_STAGE); } catch (_) {} }
function reportCrashedStage() {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(LS_KEY_STT_STAGE) || 'null'); } catch (_) {}
    if (!rec) return;
    clearStage();
    const box = document.getElementById('sttRecoveryBanner');
    if (!box) return;
    box.style.display = 'block';
    const flags = Object.entries(rec.flags || {}).filter(([, v]) => v).map(([k]) => k).join(',') || 'none';
    const div = document.createElement('div');
    div.innerHTML = `<strong>Previous attempt crashed.</strong> The page was killed during stage: <strong>${rec.name}</strong> (model ${String(rec.model).replace('onnx-community/', '')}, flags: ${flags}, ${new Date(rec.at).toLocaleTimeString()}). Please report this stage name.`;
    box.prepend(div);
}
if (typeof document !== 'undefined') setTimeout(reportCrashedStage, 500);

function getModelConfig() {
    // Whisper on transformers.js works best with a PER-MODULE dtype:
    //   - encoder: fp32 (small, accuracy-critical, no quant artifacts)
    //   - decoder_model_merged: q4 (large, can be quantized safely)
    // A single `dtype: 'q8'` triggers ORT's QDQ optimizer to look for scales
    // that aren't present in the published merged ONNX file and fails with:
    //   "Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale"
    // The per-module form is the configuration the Xenova examples ship with
    // and is verified to load on every Whisper variant.
    //
    // WebGPU (opt-in) keeps the fp16 fast-path for the whole graph.
    if (!STT_FORCE_WASM && hasWebGPU && !isMobile) {
        return { dtype: 'fp16', device: 'webgpu', suffix: 'GPU' };
    }
    if (isMobile) {
        // q8 encoder, NOT fp32: whisper-small's fp32 encoder is 337 MB and the
        // transient copies during session init pushed an iPhone 17 Pro over
        // WebKit's per-tab memory limit — the page refreshed during model
        // download. q8 encoder (88 MB) + q4 decoder halves the peak.
        return {
            dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
            device: 'wasm',
            suffix: 'q8/q4',
        };
    }
    return {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        device: 'wasm',
        suffix: '',
    };
}

const STT_MODEL_OPTIONS = {
    'onnx-community/whisper-tiny': {
        id: 'onnx-community/whisper-tiny',
        label: 'Whisper Tiny',
        sizeWasm: '~150 MB',
        sizeMobile: '~45 MB',
        sizeMobileMB: 45,
        sizeGpu: '~150 MB',
        sizeMB: 150,
        description: 'Fastest, lowest resource usage. WER (FLEURS): Dutch 49%, English 12% — not usable for Dutch.',
        quality: 'Basic (English only)',
    },
    'onnx-community/whisper-base': {
        id: 'onnx-community/whisper-base',
        label: 'Whisper Base',
        sizeWasm: '~300 MB',
        sizeMobile: '~105 MB',
        sizeMobileMB: 105,
        sizeGpu: '~290 MB',
        sizeMB: 300,
        description: 'Middle ground. WER (FLEURS): Dutch 33%, English 9%.',
        quality: 'Fair',
    },
    'onnx-community/whisper-small': {
        id: 'onnx-community/whisper-small',
        label: 'Whisper Small',
        sizeWasm: '~500 MB',
        sizeMobile: '~310 MB',
        sizeMobileMB: 310,
        sizeGpu: '~460 MB',
        sizeMB: 500,
        description: 'Best accuracy that fits a browser tab. WER (FLEURS): Dutch 16%, English 6%. Runs on iPhone (q4, ~170 MB) but slower than real time there. See “Accuracy: what to expect” above.',
        quality: 'Good',
    },
};

// Small everywhere: tiny/base are not accurate enough for Dutch (see Benchmark tab).
// On iPhone/iPad the q4 build (~170 MB) fits the per-tab memory cap (verified in the iOS Simulator).
const DEFAULT_STT_MODEL = isIos ? 'onnx-community/whisper-base' : 'onnx-community/whisper-small';

// ── State ──────────────────────────────────────────────────────────────────────
let pipeline = null;
let loadedModelId = null;
let isModelLoading = false;
let isPipelineWarm = false;   // set true after a successful warm-up inference
let isTranscribing = false;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let transcriptionResult = null;

// ── Recording PCM State ───────────────────────────────────────────────────────
// Live (as-you-speak) transcription is deliberately NOT offered: in-browser
// Whisper is slower than real time on phones and the chunked loop was the
// source of the "transcribing… hangs" reports. The flow is strictly two-phase:
// 1) record — raw 16 kHz PCM is captured straight from the microphone graph,
// 2) transcribe — one inference on that PCM after Stop (starts automatically).
// MediaRecorder is only used to produce a downloadable file; transcription
// never depends on decoding its container (which fails on some browsers).
let pcmChunks = [];
let pcmSampleCount = 0;
let recordedPCM = null;       // Float32Array @ 16 kHz from the last recording
let whisperStreamerCtor = null; // WhisperTextStreamer class, for per-chunk progress
// Crash-safety (see stt-store.js): every recording is persisted to IndexedDB
// while it happens, and transcription progress is checkpointed per segment,
// so a browser kill (iOS memory pressure) never loses audio or finished text.
let recSessionId = null;        // active recovery-session id
let recFlushBuf = [];           // PCM chunks waiting to be flushed to IndexedDB
let recFlushLen = 0;
let recFlushSeq = 0;
let recFlushTimer = null;
const REC_FLUSH_SECONDS = 5;    // persist at least every ~5 s of audio
const SEGMENT_SECONDS = 120;    // outer transcription segments (checkpointed)
const SEGMENT_OVERLAP_SECONDS = 2;
let loadedModelSizeMB = 0;
let recAudioCtx = null;
let recSourceNode = null;
let recProcessorNode = null;
let recSampleRate = 16000;
let recStream = null;

// ── Audio Quality & Hallucination Guards ───────────────────────────────────────
const SILENCE_RMS_THRESHOLD = 0.01;  // below this RMS the chunk is considered silent

function isAudioSilent(float32Array) {
    let sumSq = 0;
    for (let i = 0; i < float32Array.length; i++) sumSq += float32Array[i] * float32Array[i];
    const rms = Math.sqrt(sumSq / float32Array.length);
    return rms < SILENCE_RMS_THRESHOLD;
}

// Known Whisper hallucination patterns (case-insensitive fragments)
const HALLUCINATION_PATTERNS = [
    /^\.+$/,                        // just dots/periods
    /^(,\s*)+$/,                    // just commas
    /^\s*$/,                        // whitespace only
    /ondertitels/i,                 // Dutch subtitle hallucination
    /subtitl/i,                     // subtitle hallucination
    /gelderland/i,                  // common Dutch hallucination
    /amara\.org/i,                  // Whisper training data leak
    /www\./i,                       // URL hallucinations
    /copyright/i,                   // copyright notice hallucinations
    /thank you for watching/i,
    /thanks for watching/i,
    /bedankt voor het kijken/i,
    /tot de volgende keer/i,
];

function isHallucination(text) {
    if (!text || text.length < 2) return true;
    // Check known hallucination patterns
    for (const pat of HALLUCINATION_PATTERNS) {
        if (pat.test(text)) return true;
    }
    // Detect heavy repetition: if any single word/token makes up >60% of the text
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 3) {
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        const maxFreq = Math.max(...Object.values(freq));
        if (maxFreq / words.length > 0.6) return true;
    }
    // Detect repeated phrases (e.g. "hello hello hello")
    if (words.length >= 4) {
        // Check if the text is just 1-3 words repeated
        for (let phraseLen = 1; phraseLen <= 3; phraseLen++) {
            const phrase = words.slice(0, phraseLen).join(' ');
            const repeated = Array(Math.ceil(words.length / phraseLen)).fill(phrase).join(' ');
            if (words.join(' ') === repeated.split(/\s+/).slice(0, words.length).join(' ')) return true;
        }
    }
    return false;
}

// ── Waveform State ─────────────────────────────────────────────────────────────
let waveformAnalyser = null;
let waveformAnimId = null;

// ── Dictaphone State ───────────────────────────────────────────────────────────
let dictaphoneEntries = [];
let dictaphoneStream = null;
let dictaphoneRecording = false;
let dictaphoneMediaRec = null;
let dictaphoneChunks = [];
let dictaphonePcmChunks = [];
let dictaphonePcmCount = 0;
let dictaphoneSampleRate = 16000;
let dictaphoneAudioCtx = null;
let dictaphoneSourceNode = null;
let dictaphoneProcessorNode = null;
let dictaphoneAnalyser = null;
let dictaphoneWaveAnimId = null;
let dictaphoneEntryStart = null;
let dictaphoneSessionStart = null;

// ── DOM Elements ───────────────────────────────────────────────────────────────
const sttModelSelect = document.getElementById('sttModelSelect');
const sttLanguageSelect = document.getElementById('sttLanguageSelect');
const sttModelStatus = document.getElementById('sttModelStatus');
const sttModelProgress = document.getElementById('sttModelProgress');
const sttModelStatusText = document.getElementById('sttModelStatusText');
const sttRecordBtn = document.getElementById('sttRecordBtn');
const sttStopBtn = document.getElementById('sttStopBtn');
const sttUploadArea = document.getElementById('sttUploadArea');
const sttFileInput = document.getElementById('sttFileInput');
const sttFileInfo = document.getElementById('sttFileInfo');
const sttFileName = document.getElementById('sttFileName');
const sttRecordingIndicator = document.getElementById('sttRecordingIndicator');
const sttProgress = document.getElementById('sttProgress');
const sttProgressBar = document.getElementById('sttProgressBar');
const sttProgressText = document.getElementById('sttProgressText');
const sttResults = document.getElementById('sttResults');
const sttOutputText = document.getElementById('sttOutputText');
const sttCopyBtn = document.getElementById('sttCopyBtn');
const sttDownloadBtn = document.getElementById('sttDownloadBtn');
const transcribeBtn = document.getElementById('transcribeBtn');

const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');
const sttLiveTranscript = document.getElementById('sttLiveTranscript');
const sttLiveText = document.getElementById('sttLiveText');
const sttLiveStatus = document.getElementById('sttLiveStatus');
const sttWaveformCanvas = document.getElementById('sttWaveformCanvas');

// Dictaphone DOM
const sttModeSelect = document.getElementById('sttModeSelect');
const sttTranscribeSection = document.getElementById('sttTranscribeSection');
const sttDictaphoneSection = document.getElementById('sttDictaphoneSection');
const dictRecordBtn = document.getElementById('dictRecordBtn');
const dictStopBtn = document.getElementById('dictStopBtn');
const dictWaveformCanvas = document.getElementById('dictWaveformCanvas');
const dictRecordingIndicator = document.getElementById('dictRecordingIndicator');
const dictLog = document.getElementById('dictLog');
const dictLogBody = document.getElementById('dictLogBody');
const dictExportBtn = document.getElementById('dictExportBtn');
const dictClearBtn = document.getElementById('dictClearBtn');
const dictEntryCount = document.getElementById('dictEntryCount');


function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// ── Populate Selects ───────────────────────────────────────────────────────────
function populateSTTModelSelect() {
    if (!sttModelSelect) return;
    sttModelSelect.innerHTML = '';
    const cfg = getModelConfig();
    let stored = null;
    try { stored = localStorage.getItem(LS_KEY_STT_MODEL); } catch (_) {}
    const storedOpt = stored && STT_MODEL_OPTIONS[stored];
    const storedFits = storedOpt && !(isIos && (storedOpt.sizeMobileMB || storedOpt.sizeMB || 0) > IOS_MAX_STT_MB);
    const desired = storedFits ? stored : DEFAULT_STT_MODEL;
    for (const [id, opt] of Object.entries(STT_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        const size = isMobile ? opt.sizeMobile : (hasWebGPU ? opt.sizeGpu : opt.sizeWasm);
        const badge = cfg.suffix ? ` [${cfg.suffix}]` : '';
        const tooBig = isIos && (opt.sizeMobileMB || opt.sizeMB || 0) > IOS_MAX_STT_MB;
        el.textContent = `${opt.label} (${size})${badge}${tooBig ? ' — desktop only' : ''}`;
        el.disabled = tooBig;
        if (id === desired) el.selected = true;
        sttModelSelect.appendChild(el);
    }
}

// ── Model Loading ──────────────────────────────────────────────────────────────
function getSelectedModel() {
    return sttModelSelect ? sttModelSelect.value : DEFAULT_STT_MODEL;
}

function formatLoadError(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

async function initSTTModel(externalProgressCb) {
    const selectedModel = getSelectedModel();
    if (isIos && sttEverLoaded && loadedModelId !== selectedModel && dictaphoneEntries.length === 0) {
        // Heap already grown by a previous model this session — reload for a
        // clean slate, remembering the chosen model. The user re-triggers the
        // action after the (fast, cached) reload.
        try { localStorage.setItem(LS_KEY_STT_MODEL, selectedModel); } catch (_) {}
        updateStatus('loading', 'Reloading the page to free memory for the new model…');
        setTimeout(() => location.reload(), 600);
        throw new Error('Reloading to free memory — tap again after the page returns.');
    }
    const selOpt = STT_MODEL_OPTIONS[selectedModel];
    if (isIos && (selOpt?.sizeMobileMB || selOpt?.sizeMB || 0) > IOS_MAX_STT_MB) {
        throw new Error('This Whisper model is too large for iPhone/iPad (the page would reload). Whisper Base is the largest model that runs here; use a desktop browser for Whisper Small.');
    }
    if (pipeline && loadedModelId === selectedModel) return;
    if (isModelLoading) return;

    if (pipeline) {
        await disposeSTTModel();
    }

    const modelLabel = STT_MODEL_OPTIONS[selectedModel]?.label || selectedModel;
    const sizeMB = STT_MODEL_OPTIONS[selectedModel]?.sizeMB || 0;

    const proceed = await preflightWarn({
        key: `stt:${selectedModel}`,
        title: 'Load speech-to-text model?',
        model: modelLabel,
        sizeMB,
        why: 'Whisper runs locally for transcription. Larger models give better accuracy but use more RAM. WebGPU is much faster on Apple Silicon and modern GPUs.',
    });
    if (!proceed) {
        throw new Error('Model load cancelled by user');
    }

    sttEverLoaded = true;
    return withHeavyLoadLock(`STT: ${modelLabel}`, async () => {
        isModelLoading = true;
        if (sttModelStatus) sttModelStatus.style.display = 'block';
        if (sttModelProgress) sttModelProgress.style.width = '0%';

        const sttModelHeading = document.getElementById('sttModelHeading');
        if (sttModelHeading) sttModelHeading.textContent = `Loading ${modelLabel}...`;
        if (sttModelStatusText) sttModelStatusText.textContent = `Initializing ${modelLabel}...`;
        updateStatus('loading', `Loading ${modelLabel}...`);

        try {
            stage('import-transformers');
            const { pipeline: createPipeline, env, WhisperTextStreamer } = await import('@huggingface/transformers');
            whisperStreamerCtor = WhisperTextStreamer || null;
            env.allowLocalModels = false;
            env.useBrowserCache = !STT_NO_CACHE;
            if (STT_NO_CACHE) console.warn('[STT] browser cache disabled via ?stt-no-cache=1');

            // Pin onnxruntime-web's WASM/JSEP glue to the exact nightly we use
            // in the import map. Without this, transformers.js builds the path
            // from ONNX_ENV.versions.web which can drift, and the JSEP glue
            // (ort-wasm-simd-threaded.jsep.mjs) fails to load — in which case
            // Module.webgpuInit is never attached and the WebGPU backend errors
            // with: "z().webgpuInit is not a function".
            const { dtype: modelDtype, device: modelDevice } = getModelConfig();
            console.log(`[STT] Using device: ${modelDevice}, dtype:`, modelDtype);
            const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/';
            if (env.backends?.onnx?.wasm) {
                env.backends.onnx.wasm.wasmPaths = ORT_DIST;
                // Run the WASM backend in a worker ("proxy") so a long inference
                // never blocks the main thread. Without this, browsers that lack
                // cross-origin isolation (no SharedArrayBuffer → single-threaded
                // WASM on the main thread, e.g. iOS Safari) freeze the whole page
                // for the duration of a transcription — the classic "it hangs".
                // The proxy is WASM-only; the opt-in WebGPU path must not use it.
                env.backends.onnx.wasm.proxy = modelDevice === 'wasm' && !STT_NO_PROXY;
                if (STT_NO_PROXY) console.warn('[STT] proxy worker disabled via ?stt-no-proxy=1');
            }

            const fileProgress = {};
            const loggedFiles = new Set();

            stage('create-pipeline (download + ONNX session init)');
            pipeline = await createPipeline('automatic-speech-recognition', selectedModel, {
                dtype: modelDtype,
                device: modelDevice,
                progress_callback: (progress) => {
                    if (progress.file && !loggedFiles.has(progress.file)) {
                        loggedFiles.add(progress.file);
                        console.log('[STT] loading file', progress.file);
                    }
                    if (progress.status === 'progress' && progress.total > 0) {
                        const file = progress.file || 'data';
                        fileProgress[file] = { loaded: progress.loaded, total: progress.total };
                        const loaded = Object.values(fileProgress).reduce((a, c) => a + c.loaded, 0);
                        const total = Object.values(fileProgress).reduce((a, c) => a + c.total, 0);
                        const pct = Math.round((loaded / total) * 100);
                        if (sttModelProgress) sttModelProgress.style.width = pct + '%';
                        if (sttModelStatusText) sttModelStatusText.textContent = `Loading ${modelLabel}: ${pct}%`;
                        updateStatus('loading', `Loading ${modelLabel}: ${pct}%`);
                        if (externalProgressCb) externalProgressCb(progress);
                    } else if (progress.status === 'done') {
                        if (sttModelStatusText) sttModelStatusText.textContent = `Initializing ${modelLabel}...`;
                    }
                },
            });

            if (sttModelStatusText) sttModelStatusText.textContent = `${modelLabel} loaded ✓`;
            if (sttModelProgress) sttModelProgress.style.width = '100%';
            loadedModelId = selectedModel;
            loadedModelSizeMB = sizeMB;
            registerLoadedModel('stt', disposeSTTModel, { sizeMB });

            // Pre-warm the pipeline: run one inference on 1 s of silence so all
            // ONNX kernels are JIT-compiled now (during loading state) instead
            // of during the first live chunk — the source of the "hang at first
            // transcribe" complaint. Bounded by a 60 s timeout in case warm-up
            // itself stalls (we then just continue without warm; live loop will
            // pay the cost on its own first chunk).
            isPipelineWarm = false;
            try {
                if (STT_NO_WARM) { console.warn('[STT] warm-up skipped via ?stt-no-warm=1'); isPipelineWarm = true; throw { __skip: true }; }
                stage('warm-up inference');
                if (sttModelStatusText) sttModelStatusText.textContent = `Warming up ${modelLabel}…`;
                const warmAudio = new Float32Array(16000); // 1 s of silence at 16 kHz
                const warmLang = (sttLanguageSelect && sttLanguageSelect.value) || 'en';
                const warmTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('warm-up timeout')), 60000));
                await Promise.race([
                    pipeline(warmAudio, { language: warmLang, task: 'transcribe', return_timestamps: false }),
                    warmTimeout,
                ]);
                isPipelineWarm = true;
                console.log('[STT] pipeline pre-warmed');
            } catch (warmErr) {
                if (warmErr && warmErr.__skip) { /* deliberate skip */ } else
                console.warn('[STT] pre-warm failed (continuing anyway):', warmErr);
                isPipelineWarm = true; // allow inference even if warm-up didn't finish; first real chunk will compile
            }

            clearStage(); // survived the whole load
            updateStatus('idle', 'System Ready');
            setTimeout(() => { if (sttModelStatus) sttModelStatus.style.display = 'none'; }, 2000);
        } catch (error) {
            console.error('STT model loading error:', error);
            if (sttModelStatusText) sttModelStatusText.textContent = 'Error: ' + formatLoadError(error);
            updateStatus('idle', 'STT model loading failed');
            pipeline = null;
            throw error;
        } finally {
            isModelLoading = false;
        }
    });
}

async function disposeSTTModel() {
    if (!pipeline) {
        loadedModelId = null;
        return;
    }
    try {
        if (typeof pipeline.dispose === 'function') {
            await pipeline.dispose();
        }
    } catch (e) {
        console.warn('Error disposing STT pipeline:', e);
    }
    pipeline = null;
    loadedModelId = null;
    isPipelineWarm = false;
    unregisterLoadedModel('stt');
}

// ── Crash-safe recording persistence ──────────────────────────────────────────
function queueRecoveryFlush(chunk) {
    if (!recSessionId) return;
    recFlushBuf.push(chunk);
    recFlushLen += chunk.length;
    if (recFlushLen >= recSampleRate * REC_FLUSH_SECONDS && !recFlushTimer) {
        recFlushTimer = setTimeout(flushRecovery, 0);
    }
}
async function flushRecovery() {
    recFlushTimer = null;
    if (!recSessionId || recFlushBuf.length === 0) return;
    const parts = recFlushBuf; recFlushBuf = []; recFlushLen = 0;
    let merged = new Float32Array(parts.reduce((a, c) => a + c.length, 0));
    let pos = 0; for (const c of parts) { merged.set(c, pos); pos += c.length; }
    if (recSampleRate !== 16000) merged = resampleTo16k(merged, recSampleRate);
    try { await appendChunk(recSessionId, recFlushSeq++, merged); }
    catch (err) { console.warn('[STT] recovery flush failed:', err.message); }
}

const sttRecoveryBanner = document.getElementById('sttRecoveryBanner');
async function checkRecovery() {
    if (!sttRecoveryBanner) return;
    let sess = null;
    try { sess = await findRecoverable(); } catch { return; }
    if (!sess) return;
    const secs = Math.round((sess.samples || 0) / 16000);
    const when = new Date(sess.startedAt).toLocaleString();
    const partial = sess.transcript ? ` ${Math.round((sess.doneSamples || 0) / (sess.samples || 1) * 100)}% was already transcribed and is kept.` : '';
    sttRecoveryBanner.style.display = 'block';
    sttRecoveryBanner.innerHTML = `
        <strong>Recovered recording</strong> — ${formatSeconds(secs)} from ${when}. The browser closed before transcription finished; the audio was saved safely on this device.${partial}
        <span class="stt-recovery-actions">
            <button class="btn btn-small btn-primary" data-rec="resume">Transcribe</button>
            <button class="btn btn-small btn-ghost" data-rec="download">Download WAV</button>
            <button class="btn btn-small btn-ghost" data-rec="discard">Discard</button>
        </span>`;
    sttRecoveryBanner.onclick = async (ev) => {
        const act = ev.target.closest('[data-rec]')?.dataset.rec;
        if (!act) return;
        try {
            if (act === 'download') {
                const pcm = await loadPCM(sess.id);
                saveAs(pcmToWavBlob(pcm), `medmorf-recovered-${sess.id}.wav`);
                return; // keep the banner; user may still transcribe or discard
            }
            if (act === 'discard') {
                await deleteSession(sess.id);
                sttRecoveryBanner.style.display = 'none';
                return;
            }
            if (act === 'resume') {
                sttRecoveryBanner.style.display = 'none';
                recordedPCM = await loadPCM(sess.id);
                recordedBlob = null;
                recSessionId = sess.id; // reuse the session for checkpointing
                if (sttFileInfo) { sttFileInfo.style.display = 'block'; if (sttFileName) sttFileName.textContent = `Recovered audio (${formatSeconds(recordedPCM.length / 16000)})`; }
                if (transcribeBtn) transcribeBtn.disabled = false;
                await performTranscription();
            }
        } catch (err) {
            console.error('[STT] recovery action failed:', err);
            alert('Recovery failed: ' + err.message);
        }
    };
}
checkRecovery();

function resumeWithTimeout(ctx, ms = 1000) {
    if (ctx.state !== 'suspended') return Promise.resolve();
    return Promise.race([
        ctx.resume().catch(() => {}),
        new Promise(r => setTimeout(r, ms)),
    ]).then(() => { if (ctx.state === 'suspended') console.warn('[STT] AudioContext still suspended — audio may be silent until the user interacts'); });
}

// ── Recording PCM Capture ─────────────────────────────────────────────────────
async function setupPCMCapture(stream) {
    // NEVER force sampleRate: on iOS the mic runs at 48 kHz and an AudioContext
    // pinned to 16 kHz feeding a MediaStreamSource is a known WebKit crasher
    // ("a problem repeatedly occurred"). Capture at the hardware rate and
    // resample to 16 kHz in software when the buffer is collected.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    recAudioCtx = ctx;
    // resume() can stay pending forever when the browser withholds activation —
    // NEVER await it unbounded or the Record button hangs with no feedback.
    resumeWithTimeout(ctx);
    recSampleRate = ctx.sampleRate;
    recSourceNode = ctx.createMediaStreamSource(stream);

    try {
        const workletCode = [
            'class P extends AudioWorkletProcessor {',
            '  process(inputs) {',
            '    const d = inputs[0] && inputs[0][0];',
            '    if (d && d.length) this.port.postMessage(new Float32Array(d));',
            '    return true;',
            '  }',
            '}',
            'registerProcessor("pcm-cap", P);',
        ].join('\n');
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await recAudioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        recProcessorNode = new AudioWorkletNode(recAudioCtx, 'pcm-cap');
        recProcessorNode.port.onmessage = (e) => {
            pcmChunks.push(e.data);
            pcmSampleCount += e.data.length;
            queueRecoveryFlush(e.data);
        };
        recSourceNode.connect(recProcessorNode);
        console.log('[STT] PCM capture via AudioWorklet at', recSampleRate, 'Hz');
    } catch (err) {
        console.warn('[STT] AudioWorklet unavailable, using ScriptProcessor fallback:', err.message);
        const proc = recAudioCtx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
            const data = new Float32Array(e.inputBuffer.getChannelData(0));
            pcmChunks.push(data);
            pcmSampleCount += data.length;
            queueRecoveryFlush(data);
        };
        recSourceNode.connect(proc);
        const silentGain = recAudioCtx.createGain();
        silentGain.gain.value = 0;
        proc.connect(silentGain);
        silentGain.connect(recAudioCtx.destination);
        recProcessorNode = proc;
        console.log('[STT] PCM capture via ScriptProcessor at', recSampleRate, 'Hz');
    }
}

function collectAllPCM() {
    const totalLen = pcmChunks.reduce((a, c) => a + c.length, 0);
    const result = new Float32Array(totalLen);
    let pos = 0;
    for (const chunk of pcmChunks) { result.set(chunk, pos); pos += chunk.length; }
    return result;
}

function resampleTo16k(data, fromRate) {
    if (fromRate === 16000) return data;
    const ratio = fromRate / 16000;
    const newLen = Math.round(data.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, data.length - 1);
        const frac = srcIdx - lo;
        out[i] = data[lo] * (1 - frac) + data[hi] * frac;
    }
    return out;
}

async function cleanupPCMCapture() {
    if (recSourceNode) { try { recSourceNode.disconnect(); } catch (_) {} recSourceNode = null; }
    if (recProcessorNode) { try { recProcessorNode.disconnect(); } catch (_) {} recProcessorNode = null; }
    if (recAudioCtx && recAudioCtx.state !== 'closed') {
        try { await recAudioCtx.close(); } catch (_) {}
    }
    recAudioCtx = null;
}

function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
    }
    return '';
}

// ── Audio Recording ────────────────────────────────────────────────────────────

/**
 * Acquire the microphone with explicit, classified error reporting.
 * Must be called synchronously inside a user-gesture handler (or before any
 * long async work) so the browser actually shows its permission prompt.
 *
 * @param {(msg:string,kind:'info'|'error')=>void} report  UI status reporter
 * @returns {Promise<MediaStream|null>}
 */
async function acquireMicStream(report) {
    // 1. Insecure context — getUserMedia rejects silently on http:// (except localhost).
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
        report('Microphone blocked: this page must be served over HTTPS (or localhost). Open the site via its https:// URL and try again.', 'error');
        return null;
    }
    // 2. API missing (very old browser, or disabled by enterprise policy / Permissions-Policy).
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        report('Microphone unavailable: this browser does not expose mediaDevices.getUserMedia. Try Chrome, Edge, Firefox or Safari, and check that microphone isn’t disabled by your browser/OS or a Permissions-Policy header.', 'error');
        return null;
    }
    // NOTE: no permissions.query pre-check — WebKit can report 'denied' in
    // states where a prompt would still be shown, which made Record exit
    // silently. getUserMedia itself is the only authority.
    try {
        console.log('[stt] requesting microphone…');
        return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        const name = err && err.name;
        let msg;
        switch (name) {
            case 'NotAllowedError':
            case 'SecurityError':
                msg = 'Microphone permission denied. Click the lock/info icon in the address bar and allow microphone access, then try again.';
                break;
            case 'NotFoundError':
            case 'OverconstrainedError':
                msg = 'No microphone found. Connect a microphone (or check OS sound settings) and try again.';
                break;
            case 'NotReadableError':
                msg = 'Microphone is in use by another application. Close other apps using the mic and try again.';
                break;
            case 'AbortError':
                msg = 'Microphone request was aborted. Try again.';
                break;
            default:
                msg = `Microphone error: ${name || 'unknown'} — ${err && err.message ? err.message : 'no details'}.`;
        }
        console.error('[stt] getUserMedia failed:', err);
        report(msg, 'error');
        return null;
    }
}

async function startRecording() {
    console.log('[stt] startRecording, isRecording=', isRecording);
    if (isRecording) return;

    const report = (msg, _kind) => {
        if (sttLiveStatus) {
            if (sttLiveTranscript) sttLiveTranscript.style.display = 'block';
            sttLiveStatus.textContent = msg;
        }
    };

    // Acquire mic synchronously inside the user-gesture so the permission
    // prompt is guaranteed to appear.
    if (sttRecordBtn) sttRecordBtn.disabled = true;
    const stream = await acquireMicStream(report);
    console.log('[stt] mic stream:', stream ? 'acquired' : 'NULL (see message above)');
    if (!stream) {
        if (sttRecordBtn) sttRecordBtn.disabled = false;
        return;
    }

    try {
        if (sttRecordBtn) sttRecordBtn.disabled = false;

        audioChunks = [];
        recordedBlob = null;
        recordedPCM = null;
        transcriptionResult = null;
        pcmChunks = [];
        pcmSampleCount = 0;
        recSessionId = 'rec-' + Date.now();
        recFlushBuf = []; recFlushLen = 0; recFlushSeq = 0;
        try { await startSession(recSessionId); } catch (err) { console.warn('[STT] recovery store unavailable:', err.message); recSessionId = null; }

        // Raw PCM capture — this is what gets transcribed.
        await setupPCMCapture(stream);
        console.log('[stt] PCM capture ready at', recSampleRate, 'Hz; ctx state:', recAudioCtx?.state);

        // MediaRecorder only for the downloadable file; optional.
        const mime = pickRecorderMime();
        if (mime !== null) {
            try {
                mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
                mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
                mediaRecorder.onstop = () => { recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || mime || 'audio/webm' }); };
                mediaRecorder.start(1000);
            } catch (err) {
                console.warn('[stt] MediaRecorder unavailable, download disabled:', err.message);
                mediaRecorder = null;
            }
        } else {
            mediaRecorder = null;
        }
        mediaRecorder && (mediaRecorder._stream = stream);
        recStream = stream;

        // Waveform visualiser (visual feedback only).
        startWaveform(stream, sttWaveformCanvas, 'stt');
        isRecording = true;

        // UI: show recording state. The live-transcript box is intentionally
        // hidden — it caused confusion when the live path was unreliable.
        if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'flex';
        if (sttRecordBtn) sttRecordBtn.style.display = 'none';
        if (sttStopBtn) sttStopBtn.style.display = '';
        if (sttResults) sttResults.style.display = 'none';
        if (sttLiveTranscript) sttLiveTranscript.style.display = 'none';
        if (sttWaveformCanvas) sttWaveformCanvas.style.display = 'block';
    } catch (error) {
        console.error('[stt] recording setup failed after mic acquired:', error);
        // Release the mic since we never started recording.
        try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        report(`Could not start transcription: ${error && error.message ? error.message : error}`, 'error');
        if (sttRecordBtn) {
            sttRecordBtn.disabled = false;
            sttRecordBtn.style.display = '';
        }
        if (sttStopBtn) sttStopBtn.style.display = 'none';
        if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'none';
    }
}

async function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    // Stop MediaRecorder (download only)
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (_) {}
    }

    // Freeze the PCM buffer and tear down the audio graph
    let pcm = collectAllPCM();
    if (recSampleRate !== 16000) pcm = resampleTo16k(pcm, recSampleRate);
    recordedPCM = pcm;
    await flushRecovery();
    if (recSessionId) { try { await updateSession(recSessionId, { state: 'recorded' }); } catch (_) {} }
    pcmChunks = [];
    pcmSampleCount = 0;
    await cleanupPCMCapture();

    // Stop waveform
    stopWaveform('stt');

    // Stop mic stream
    if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }

    // UI
    if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'none';
    if (sttRecordBtn) sttRecordBtn.style.display = '';
    if (sttStopBtn) sttStopBtn.style.display = 'none';
    if (sttWaveformCanvas) sttWaveformCanvas.style.display = 'none';

    if (sttLiveTranscript) sttLiveTranscript.style.display = 'none';

    const seconds = recordedPCM.length / 16000;
    if (sttFileInfo) {
        sttFileInfo.style.display = 'block';
        if (sttFileName) sttFileName.textContent = `Recorded audio (${formatSeconds(seconds)})`;
    }
    if (transcribeBtn) transcribeBtn.disabled = false;

    if (seconds < 0.5 || isAudioSilent(recordedPCM)) {
        renderSTTResults('(no speech detected)');
        return;
    }
    // Phase 2 starts automatically — no extra click needed.
    await performTranscription();
}

// ── Audio Processing ───────────────────────────────────────────────────────────
async function decodeAudioToFloat32(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    // Default-rate context; decodeAudioData resamples to it and the explicit
    // resampleTo16k below normalises — forcing 16 kHz here crashed iOS WebKit.
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        let data = audioBuffer.getChannelData(0); // mono
        if (audioBuffer.sampleRate !== 16000) data = resampleTo16k(data, audioBuffer.sampleRate);
        return data;
    } catch (err) {
        throw new Error(`This browser cannot decode this audio format (${blob.type || 'unknown'}). Convert it to WAV or MP3 and try again.`);
    } finally {
        try { audioContext.close(); } catch (_) {}
    }
}

// While an inference is running the lifecycle manager must not dispose the
// model (it evicts 60 s after the tab is hidden — a user switching apps during
// a 15-minute transcription on a phone would otherwise lose the whole run).
function setEvictionGuard(on) {
    if (!pipeline) return;
    registerLoadedModel('stt', disposeSTTModel, { sizeMB: loadedModelSizeMB, autoEvict: !on });
}

// Build a progress streamer for a long clip: reports "chunk k of N" and the
// running transcript so a 15-minute file never looks frozen.
function makeProgressStreamer(clipSeconds, chunkLen, stride, onProgress) {
    if (!whisperStreamerCtor || !pipeline?.tokenizer) return null;
    const step = Math.max(1, chunkLen - 2 * stride);
    const totalChunks = Math.max(1, Math.ceil(clipSeconds / step));
    let chunk = 0;
    let textSoFar = '';
    try {
        return new whisperStreamerCtor(pipeline.tokenizer, {
            skip_prompt: true,
            on_chunk_start: () => { chunk += 1; onProgress(chunk, totalChunks, textSoFar); },
            callback_function: (t) => { textSoFar = (textSoFar + t).slice(-2000); onProgress(chunk, totalChunks, textSoFar); },
        });
    } catch (err) {
        console.warn('[STT] streamer unavailable:', err.message);
        return null;
    }
}

// ── Transcription ──────────────────────────────────────────────────────────────
async function performTranscription() {
    if (isTranscribing || (!recordedPCM && !recordedBlob)) return;

    isTranscribing = true;
    if (transcribeBtn) transcribeBtn.disabled = true;
    if (sttModelSelect) sttModelSelect.disabled = true;
    if (sttResults) sttResults.style.display = 'none';
    if (sttProgress) sttProgress.style.display = 'block';
    if (sttProgressBar) sttProgressBar.style.width = '0%';

    try {
        if (sttProgressText) sttProgressText.textContent = 'Loading Whisper model...';
        updateStatus('loading', 'Loading Whisper model...');
        await initSTTModel();

        if (sttProgressText) sttProgressText.textContent = 'Decoding audio...';
        if (sttProgressBar) sttProgressBar.style.width = '30%';
        updateStatus('translating', 'Decoding audio...');

        stage('decode-audio');
        const audioData = recordedPCM || await decodeAudioToFloat32(recordedBlob);
        const clipSeconds = audioData.length / 16000;

        if (sttProgressText) sttProgressText.textContent = `Transcribing ${formatSeconds(clipSeconds)} of audio… ${isMobile ? '(on a phone this takes roughly as long as the recording)' : ''}`;
        if (sttProgressBar) sttProgressBar.style.width = '50%';
        updateStatus('translating', 'Transcribing audio...');

        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';

        // Segmented, checkpointed inference: the clip is processed in
        // SEGMENT_SECONDS pieces, each finished segment's text is persisted to
        // IndexedDB, and only one segment's working memory is alive at a time.
        // If the browser is killed mid-way (iOS memory pressure), the next
        // visit offers the saved audio + the already-finished text.
        const chunkLen = isMobile ? 15 : 30;
        const stride = isMobile ? 3 : 5;
        const segLen = SEGMENT_SECONDS * 16000;
        const overlap = SEGMENT_OVERLAP_SECONDS * 16000;
        const totalSegs = Math.max(1, Math.ceil(audioData.length / segLen));

        // Resume support: skip segments already done in a recovered session.
        let doneSamples = 0;
        let pieces = [];
        if (recSessionId) {
            try {
                const sess = await getSession(recSessionId);
                if (sess?.transcript && sess.doneSamples > 0 && sess.doneSamples < audioData.length) {
                    doneSamples = sess.doneSamples;
                    pieces = [sess.transcript];
                }
                await updateSession(recSessionId, { state: 'transcribing' });
            } catch (_) { /* recovery store unavailable */ }
        }

        stage('transcribe inference');
        setEvictionGuard(true);
        const tStart = performance.now();
        try {
            for (let seg = Math.floor(doneSamples / segLen); seg < totalSegs; seg++) {
                const from = seg * segLen === 0 ? 0 : seg * segLen - overlap;
                const to = Math.min(audioData.length, (seg + 1) * segLen);
                const segAudio = audioData.subarray(from, to);
                const segSeconds = segAudio.length / 16000;
                const segTimeout = Math.max(5 * 60 * 1000, segSeconds * 6 * 1000);
                const streamer = makeProgressStreamer(segSeconds, chunkLen, stride, (k, n, text) => {
                    const fracSeg = Math.min(k, n) / n;
                    const frac = (seg + fracSeg) / totalSegs;
                    const elapsed = (performance.now() - tStart) / 1000;
                    const doneFrac = (seg - Math.floor(doneSamples / segLen)) + fracSeg;
                    const eta = doneFrac > 0.2 ? Math.max(0, Math.round(elapsed / doneFrac * (totalSegs - Math.floor(doneSamples / segLen) - doneFrac))) : null;
                    if (sttProgressBar) sttProgressBar.style.width = (50 + frac * 50).toFixed(0) + '%';
                    if (sttProgressText) sttProgressText.textContent = `Transcribing… ${Math.round(frac * 100)}%${totalSegs > 1 ? ` (segment ${seg + 1}/${totalSegs})` : ''}${eta != null ? ` · about ${formatSeconds(eta)} left` : ''}`;
                    if (text && sttOutputText) { sttOutputText.textContent = [...pieces, text].join('\n'); if (sttResults) sttResults.style.display = 'block'; }
                });
                let timeoutId;
                const timeoutPromise = new Promise((_, rej) => {
                    timeoutId = setTimeout(() => rej(new Error(`inference timeout after ${formatSeconds(segTimeout / 1000)} in segment ${seg + 1}/${totalSegs} — the finished part is saved; reload to resume`)), segTimeout);
                });
                let result;
                try {
                    result = await Promise.race([pipeline(segAudio, {
                        language,
                        task: 'transcribe',
                        chunk_length_s: chunkLen,
                        stride_length_s: stride,
                        return_timestamps: true,
                        ...(streamer ? { streamer } : {}),
                    }), timeoutPromise]);
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }
                pieces.push(formatTimestampedResult(result, from / 16000));
                if (recSessionId) {
                    try { await updateSession(recSessionId, { transcript: pieces.join('\n'), doneSamples: to }); } catch (_) {}
                }
                if (sttOutputText) { sttOutputText.textContent = pieces.join('\n'); if (sttResults) sttResults.style.display = 'block'; }
                await new Promise(r => setTimeout(r, 50)); // let GC/UI breathe between segments
            }
        } finally {
            setEvictionGuard(false);
        }

        if (sttProgressBar) sttProgressBar.style.width = '100%';
        if (sttProgressText) sttProgressText.textContent = 'Transcription complete ✓';

        clearStage();
        transcriptionResult = pieces.join('\n');
        renderSTTResults(transcriptionResult);
        // Success: the recording no longer needs crash protection.
        if (recSessionId) { try { await deleteSession(recSessionId); } catch (_) {} recSessionId = null; }
    } catch (error) {
        console.error('Transcription error:', error);
        if (sttProgressText) sttProgressText.textContent = 'Error: ' + error.message;
        updateStatus('idle', 'Transcription failed');
    } finally {
        isTranscribing = false;
        if (transcribeBtn) transcribeBtn.disabled = false;
        if (sttModelSelect) sttModelSelect.disabled = false;
        if (sttProgress) sttProgress.style.display = 'none';
        updateStatus('idle', 'System Ready');
    }
}

function renderSTTResults(text) {
    if (sttResults) sttResults.style.display = 'block';
    if (sttOutputText) sttOutputText.textContent = text;
}

// ── File Upload ────────────────────────────────────────────────────────────────
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

setupDropArea(sttUploadArea, sttFileInput, async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3', 'wav', 'ogg', 'webm', 'm4a', 'flac', 'mp4'].includes(ext)) {
        alert('Unsupported audio format. Please upload .mp3, .wav, .ogg, .webm, .m4a, .flac, or .mp4 files.');
        return;
    }
    recordedBlob = file;
    recordedPCM = null;
    if (sttFileName) sttFileName.textContent = file.name;
    if (sttFileInfo) sttFileInfo.style.display = 'block';
    if (sttResults) sttResults.style.display = 'none';
    transcriptionResult = null;
    if (transcribeBtn) transcribeBtn.disabled = false;
});

// ── Timestamp Formatting ────────────────────────────────────────────────────────
function formatSeconds(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
        ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimestampedResult(result) {
    if (result.chunks && result.chunks.length > 0) {
        return result.chunks.map(c => {
            const start = c.timestamp?.[0] ?? 0;
            return `[${formatSeconds(start)}] ${(c.text || '').trim()}`;
        }).filter(l => l.length > 0).join('\n');
    }
    return result.text || '';
}

// ── Waveform Visualizer ─────────────────────────────────────────────────────────
// The waveform redraws ~20 fps (not 60) and is paused outright while STT
// inference is on the main thread. This frees enough CPU on lower-end
// machines that Whisper no longer appears to "hang".
const WAVEFORM_TARGET_FPS = 20;
const WAVEFORM_MIN_FRAME_MS = 1000 / WAVEFORM_TARGET_FPS;
let waveformPaused = { stt: false, dict: false };

function pauseWaveform(target) {
    waveformPaused[target] = true;
}
function resumeWaveform(target) {
    waveformPaused[target] = false;
}

function startWaveform(stream, canvas, target) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let audioCtx, analyser;

    if (target === 'stt') {
        if (!recAudioCtx) return;
        audioCtx = recAudioCtx;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        recSourceNode.connect(analyser);
        waveformAnalyser = analyser;
    } else {
        if (!dictaphoneAudioCtx) return;
        audioCtx = dictaphoneAudioCtx;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        dictaphoneSourceNode.connect(analyser);
        dictaphoneAnalyser = analyser;
    }

    waveformPaused[target] = false;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Cache canvas pixel size; only re-size when the CSS box actually changes.
    // Setting canvas.width every frame clears + reallocates the buffer and
    // triggers a layout pass, which is wasteful at 60 Hz.
    let cachedCssW = 0, cachedCssH = 0, cachedDpr = 0;
    let lastFrameMs = 0;

    function draw(now) {
        const id = requestAnimationFrame(draw);
        if (target === 'stt') waveformAnimId = id;
        else dictaphoneWaveAnimId = id;

        // Skip the frame entirely while inference is running.
        if (waveformPaused[target]) return;
        // Throttle to WAVEFORM_TARGET_FPS
        if (now - lastFrameMs < WAVEFORM_MIN_FRAME_MS) return;
        lastFrameMs = now;

        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.offsetWidth;
        const cssH = canvas.offsetHeight;
        if (cssW !== cachedCssW || cssH !== cachedCssH || dpr !== cachedDpr) {
            canvas.width = cssW * dpr;
            canvas.height = cssH * dpr;
            cachedCssW = cssW;
            cachedCssH = cssH;
            cachedDpr = dpr;
        }
        const w = canvas.width;
        const h = canvas.height;

        analyser.getByteTimeDomainData(dataArray);
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = '#dc2626';
        ctx.beginPath();

        const sliceWidth = w / bufferLength;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * h) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.lineTo(w, h / 2);
        ctx.stroke();
    }
    requestAnimationFrame(draw);
}

function stopWaveform(target) {
    if (target === 'stt') {
        if (waveformAnimId) { cancelAnimationFrame(waveformAnimId); waveformAnimId = null; }
        if (waveformAnalyser) { try { waveformAnalyser.disconnect(); } catch (_) {} waveformAnalyser = null; }
        if (sttWaveformCanvas) {
            const ctx = sttWaveformCanvas.getContext('2d');
            ctx.clearRect(0, 0, sttWaveformCanvas.width, sttWaveformCanvas.height);
        }
    } else {
        if (dictaphoneWaveAnimId) { cancelAnimationFrame(dictaphoneWaveAnimId); dictaphoneWaveAnimId = null; }
        if (dictaphoneAnalyser) { try { dictaphoneAnalyser.disconnect(); } catch (_) {} dictaphoneAnalyser = null; }
        if (dictWaveformCanvas) {
            const ctx = dictWaveformCanvas.getContext('2d');
            ctx.clearRect(0, 0, dictWaveformCanvas.width, dictWaveformCanvas.height);
        }
    }
}

// ── Mode Switching ──────────────────────────────────────────────────────────────
function switchMode(mode) {
    if (sttTranscribeSection) sttTranscribeSection.style.display = mode === 'transcribe' ? '' : 'none';
    if (sttDictaphoneSection) sttDictaphoneSection.style.display = mode === 'dictaphone' ? '' : 'none';
}

if (sttModeSelect) {
    sttModeSelect.addEventListener('change', () => switchMode(sttModeSelect.value));
}

// ── Dictaphone ──────────────────────────────────────────────────────────────────
function formatClock(date) {
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function setupDictaphonePCM(stream) {
    // Hardware-rate context, software resample — see setupPCMCapture.
    dictaphoneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    resumeWithTimeout(dictaphoneAudioCtx);
    dictaphoneSampleRate = dictaphoneAudioCtx.sampleRate;
    dictaphoneSourceNode = dictaphoneAudioCtx.createMediaStreamSource(stream);

    try {
        const workletCode = [
            'class P extends AudioWorkletProcessor {',
            '  process(inputs) {',
            '    const d = inputs[0] && inputs[0][0];',
            '    if (d && d.length) this.port.postMessage(new Float32Array(d));',
            '    return true;',
            '  }',
            '}',
            'registerProcessor("pcm-dict", P);',
        ].join('\n');
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await dictaphoneAudioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        dictaphoneProcessorNode = new AudioWorkletNode(dictaphoneAudioCtx, 'pcm-dict');
        dictaphoneProcessorNode.port.onmessage = (e) => {
            dictaphonePcmChunks.push(e.data);
            dictaphonePcmCount += e.data.length;
        };
        dictaphoneSourceNode.connect(dictaphoneProcessorNode);
    } catch (err) {
        const proc = dictaphoneAudioCtx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
            const data = new Float32Array(e.inputBuffer.getChannelData(0));
            dictaphonePcmChunks.push(data);
            dictaphonePcmCount += data.length;
        };
        dictaphoneSourceNode.connect(proc);
        const silentGain = dictaphoneAudioCtx.createGain();
        silentGain.gain.value = 0;
        proc.connect(silentGain);
        silentGain.connect(dictaphoneAudioCtx.destination);
        dictaphoneProcessorNode = proc;
    }
}

function collectDictaphonePCM() {
    const totalLen = dictaphonePcmChunks.reduce((a, c) => a + c.length, 0);
    const result = new Float32Array(totalLen);
    let pos = 0;
    for (const chunk of dictaphonePcmChunks) { result.set(chunk, pos); pos += chunk.length; }
    return result;
}

async function dictStartEntry() {
    if (dictaphoneRecording) return;

    // Find a status element to report into (fall back to alert if none exists).
    const dictStatusEl = document.getElementById('dictStatus') || document.getElementById('dictLiveStatus');
    const report = (msg, _kind) => {
        if (dictStatusEl) dictStatusEl.textContent = msg;
        else console.warn('[dict]', msg);
    };

    if (dictRecordBtn) dictRecordBtn.disabled = true;

    // 1. Acquire mic FIRST (only if we don't already have a stream).
    if (!dictaphoneStream) {
        const stream = await acquireMicStream(report);
        if (!stream) {
            if (dictRecordBtn) dictRecordBtn.disabled = false;
            return;
        }
        dictaphoneStream = stream;
    }

    try {
        // 2. Load model.
        report('Loading model...', 'info');
        await initSTTModel();
        if (dictRecordBtn) dictRecordBtn.disabled = false;

        if (!dictaphoneSessionStart) dictaphoneSessionStart = new Date();

        dictaphonePcmChunks = [];
        dictaphonePcmCount = 0;
        dictaphoneChunks = [];
        dictaphoneEntryStart = new Date();

        // Set up PCM capture
        await setupDictaphonePCM(dictaphoneStream);

        // Waveform
        startWaveform(dictaphoneStream, dictWaveformCanvas, 'dict');

        // MediaRecorder backup (optional — never let an unsupported container kill the entry)
        const dictMime = pickRecorderMime();
        try {
            dictaphoneMediaRec = dictMime ? new MediaRecorder(dictaphoneStream, { mimeType: dictMime }) : new MediaRecorder(dictaphoneStream);
            dictaphoneMediaRec.ondataavailable = (e) => {
                if (e.data.size > 0) dictaphoneChunks.push(e.data);
            };
            dictaphoneMediaRec.start(500);
        } catch (err) {
            console.warn('[dict] MediaRecorder unavailable:', err.message);
            dictaphoneMediaRec = null;
        }

        dictaphoneRecording = true;
        if (dictRecordBtn) dictRecordBtn.style.display = 'none';
        if (dictStopBtn) dictStopBtn.style.display = '';
        if (dictRecordingIndicator) dictRecordingIndicator.style.display = 'flex';
        if (dictWaveformCanvas) dictWaveformCanvas.style.display = 'block';
        report('', 'info');
    } catch (error) {
        console.error('[dict] entry start failed after mic acquired:', error);
        try { dictaphoneStream && dictaphoneStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        dictaphoneStream = null;
        report(`Could not start dictation: ${error && error.message ? error.message : error}`, 'error');
        if (dictRecordBtn) {
            dictRecordBtn.disabled = false;
            dictRecordBtn.style.display = '';
        }
        if (dictStopBtn) dictStopBtn.style.display = 'none';
        if (dictRecordingIndicator) dictRecordingIndicator.style.display = 'none';
    }
}

async function dictStopEntry() {
    if (!dictaphoneRecording) return;
    dictaphoneRecording = false;
    const entryEnd = new Date();


    // Stop MediaRecorder
    if (dictaphoneMediaRec && dictaphoneMediaRec.state !== 'inactive') {
        dictaphoneMediaRec.stop();
    }

    // Stop waveform
    stopWaveform('dict');

    // Get PCM audio and free chunk buffers immediately
    const pcmData = collectDictaphonePCM();
    dictaphonePcmChunks = [];
    dictaphonePcmCount = 0;

    // Cleanup dictaphone audio nodes (but keep stream alive for next entry)
    if (dictaphoneSourceNode) { try { dictaphoneSourceNode.disconnect(); } catch (_) {} dictaphoneSourceNode = null; }
    if (dictaphoneProcessorNode) { try { dictaphoneProcessorNode.disconnect(); } catch (_) {} dictaphoneProcessorNode = null; }
    if (dictaphoneAudioCtx && dictaphoneAudioCtx.state !== 'closed') {
        try { await dictaphoneAudioCtx.close(); } catch (_) {}
    }
    dictaphoneAudioCtx = null;

    // UI
    if (dictRecordBtn) dictRecordBtn.style.display = '';
    if (dictStopBtn) dictStopBtn.style.display = 'none';
    if (dictRecordingIndicator) dictRecordingIndicator.style.display = 'none';
    if (dictWaveformCanvas) dictWaveformCanvas.style.display = 'none';

    // Transcribe the entry
    const entryIdx = dictaphoneEntries.length + 1;
    const entry = {
        nr: entryIdx,
        startTime: dictaphoneEntryStart,
        endTime: entryEnd,
        duration: ((entryEnd - dictaphoneEntryStart) / 1000).toFixed(1),
        text: '(transcribing...)',
    };
    dictaphoneEntries.push(entry);
    renderDictLog();

    // Transcribe
    try {
        await initSTTModel();
        let audioData = pcmData;
        if (dictaphoneSampleRate !== 16000) audioData = resampleTo16k(audioData, dictaphoneSampleRate);
        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';
        // Skip silent audio
        if (isAudioSilent(audioData)) {
            entry.text = '(no speech detected)';
            renderDictLog();
            return;
        }
        setEvictionGuard(true);
        let result;
        try {
            result = await pipeline(audioData, {
                language,
                task: 'transcribe',
                chunk_length_s: isMobile ? 15 : 30,
                stride_length_s: isMobile ? 3 : 5,
                return_timestamps: false,
            });
        } finally {
            setEvictionGuard(false);
        }
        const rawText = (result.text || '').trim();
        entry.text = (!rawText || isHallucination(rawText)) ? '(no speech detected)' : rawText;
    } catch (err) {
        console.error('[DICT] Transcription error:', err);
        entry.text = '(transcription failed)';
    }
    // pcmData goes out of scope here — eligible for GC
    renderDictLog();
}

function renderDictLog() {
    if (!dictLogBody) return;
    if (dictaphoneEntries.length === 0) {
        dictLogBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:1.5rem;">No entries yet. Press Record to start.</td></tr>';
        if (dictLog) dictLog.style.display = 'none';
        if (dictExportBtn) dictExportBtn.disabled = true;
        if (dictClearBtn) dictClearBtn.disabled = true;
        return;
    }
    if (dictLog) dictLog.style.display = '';
    if (dictExportBtn) dictExportBtn.disabled = false;
    if (dictClearBtn) dictClearBtn.disabled = false;
    if (dictEntryCount) dictEntryCount.textContent = `${dictaphoneEntries.length} ${dictaphoneEntries.length === 1 ? 'entry' : 'entries'}`;

    dictLogBody.innerHTML = dictaphoneEntries.map(e => `
        <tr>
            <td>${e.nr}</td>
            <td>${formatClock(e.startTime)}</td>
            <td>${formatClock(e.endTime)}</td>
            <td>${e.duration}s</td>
            <td class="dict-text-cell">${escapeHTML(e.text)}</td>
        </tr>
    `).join('');
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function dictExportXLSX() {
    if (dictaphoneEntries.length === 0) return;
    const rows = [['#', 'Start', 'End', 'Duration (s)', 'Transcription']];
    for (const e of dictaphoneEntries) {
        rows.push([
            e.nr,
            formatClock(e.startTime),
            formatClock(e.endTime),
            parseFloat(e.duration),
            e.text,
        ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Set column widths
    ws['!cols'] = [{ wch: 4 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dictaphone Log');
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `dictaphone-log-${dateStr}.xlsx`);
}

function dictClearLog() {
    dictaphoneEntries = [];
    dictaphoneSessionStart = null;
    renderDictLog();
}

async function cleanupDictaphone() {
    if (dictaphoneRecording) await dictStopEntry();
    if (dictaphoneStream) {
        dictaphoneStream.getTracks().forEach(t => t.stop());
        dictaphoneStream = null;
    }
}

// Dictaphone event listeners
if (dictRecordBtn) dictRecordBtn.addEventListener('click', dictStartEntry);
if (dictStopBtn) dictStopBtn.addEventListener('click', dictStopEntry);
if (dictExportBtn) dictExportBtn.addEventListener('click', dictExportXLSX);
if (dictClearBtn) dictClearBtn.addEventListener('click', () => {
    if (dictaphoneEntries.length > 0 && !confirm('Clear all dictaphone entries?')) return;
    dictClearLog();
});

// ── Event Listeners ────────────────────────────────────────────────────────────
if (sttRecordBtn) sttRecordBtn.addEventListener('click', startRecording);
if (sttStopBtn) sttStopBtn.addEventListener('click', stopRecording);
if (transcribeBtn) transcribeBtn.addEventListener('click', performTranscription);

if (sttCopyBtn) {
    sttCopyBtn.addEventListener('click', async () => {
        if (!transcriptionResult) return;
        try {
            await navigator.clipboard.writeText(transcriptionResult);
            sttCopyBtn.textContent = '✓ Copied!';
            setTimeout(() => { sttCopyBtn.textContent = 'Copy'; }, 2000);
        } catch (e) {
            console.error('Copy failed:', e);
        }
    });
}

if (sttDownloadBtn) {
    sttDownloadBtn.addEventListener('click', () => {
        if (!transcriptionResult) return;
        const blob = new Blob([transcriptionResult], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, 'transcription.txt');
    });
}

// Clean up when leaving the tab
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (btn.dataset.tab !== 'speech') {
            if (isRecording) await stopRecording();
            await cleanupDictaphone();
            await disposeSTTModel();
        }
    });
});

// Expose for privacy inspector and cache-manager
window.medmorfSTTData = {
    hasRecording: () => recordedBlob !== null,
    hasResult: () => transcriptionResult !== null,
    hasDictaphoneEntries: () => dictaphoneEntries.length > 0,
    isModelLoaded: () => pipeline !== null,
    getSelectedModel: () => getSelectedModel(),
    getModelConfig: () => getModelConfig(),
    preloadModel: async (progressCallback) => {
        if (pipeline && loadedModelId === getSelectedModel()) return;
        await initSTTModel(progressCallback);
    },
    clearAll: async () => {
        if (isRecording) await stopRecording();
        await cleanupDictaphone();
        recordedBlob = null;
        transcriptionResult = null;
        audioChunks = [];
        recordedPCM = null;
        pcmChunks = [];
        pcmSampleCount = 0;
        dictaphoneEntries = [];
        dictaphoneSessionStart = null;
        await disposeSTTModel();
        if (sttFileInput) sttFileInput.value = '';
        if (sttFileInfo) sttFileInfo.style.display = 'none';
        if (sttResults) sttResults.style.display = 'none';
        if (transcribeBtn) transcribeBtn.disabled = true;
        console.log('[PRIVACY] All STT data cleared');
    },
};

// ── Init ───────────────────────────────────────────────────────────────────────
populateSTTModelSelect();
console.log('[STT] Speech-to-Text module loaded');
