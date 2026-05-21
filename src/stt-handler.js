// Offline Speech-to-Text — Whisper via Transformers.js (WebAssembly/WebGPU)
// Uses whisper-small or whisper-tiny for browser-based transcription.
// Zero data leaves the browser — all processing is local.

import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-05-21-stability-1';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';

const BUILD_ID = window.MEDMORF_BUILD_ID || 'unknown-build';
console.log('[BUILD] stt-handler.js build', BUILD_ID, 'module url', import.meta.url);

// ── Model Options ──────────────────────────────────────────────────────────────
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
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
        return {
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
            device: 'wasm',
            suffix: 'q4',
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
        sizeMobile: '~40 MB',
        sizeGpu: '~150 MB',
        sizeMB: 150,
        description: 'Fastest, lowest resource usage. Good for short recordings.',
        quality: 'Basic',
    },
    'onnx-community/whisper-base': {
        id: 'onnx-community/whisper-base',
        label: 'Whisper Base',
        sizeWasm: '~300 MB',
        sizeMobile: '~80 MB',
        sizeGpu: '~290 MB',
        sizeMB: 300,
        description: 'Middle ground between tiny and small.',
        quality: 'Fair',
    },
    'onnx-community/whisper-small': {
        id: 'onnx-community/whisper-small',
        label: 'Whisper Small',
        sizeWasm: '~500 MB',
        sizeMobile: '~170 MB',
        sizeGpu: '~460 MB',
        sizeMB: 500,
        description: 'Best accuracy. Recommended with WebGPU.',
        quality: 'Good',
    },
};

const DEFAULT_STT_MODEL = isMobile
    ? 'onnx-community/whisper-tiny'
    : 'onnx-community/whisper-small';

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

// ── Live Transcription State ──────────────────────────────────────────────────
let liveSegments = [];
let pcmChunks = [];
let pcmSampleCount = 0;
let lastProcessedSample = 0;
let liveAudioCtx = null;
let liveSourceNode = null;
let liveProcessorNode = null;
let liveInterval = null;
let isChunkBusy = false;
let liveSampleRate = 16000;
// Whisper is trained on 30 s windows. Larger live chunks =
//  - dramatically better punctuation, casing and word boundaries
//  - far fewer hallucinations on short utterances
//  - fewer total inference calls → less CPU/GPU load → less "hanging"
const MIN_CHUNK_SECONDS = 5;        // wait at least 5 s before sending a chunk
const MAX_CHUNK_SECONDS = 20;       // never send more than 20 s at once,
                                    //   so a slow machine can't build a 60 s backlog
const MIN_COOLDOWN_MS = 250;        // brief pause between chunks; the loop is
                                    //   gated by isChunkBusy + MIN_CHUNK_SECONDS
let lastInferenceMs = 1000;    // adaptive: tracks how long inference takes

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
    for (const [id, opt] of Object.entries(STT_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        const size = isMobile ? opt.sizeMobile : (hasWebGPU ? opt.sizeGpu : opt.sizeWasm);
        const badge = cfg.suffix ? ` [${cfg.suffix}]` : '';
        el.textContent = `${opt.label} (${size})${badge}`;
        if (id === DEFAULT_STT_MODEL) el.selected = true;
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

    return withHeavyLoadLock(`STT: ${modelLabel}`, async () => {
        isModelLoading = true;
        if (sttModelStatus) sttModelStatus.style.display = 'block';
        if (sttModelProgress) sttModelProgress.style.width = '0%';

        const sttModelHeading = document.getElementById('sttModelHeading');
        if (sttModelHeading) sttModelHeading.textContent = `Loading ${modelLabel}...`;
        if (sttModelStatusText) sttModelStatusText.textContent = `Initializing ${modelLabel}...`;
        updateStatus('loading', `Loading ${modelLabel}...`);

        try {
            const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
            env.allowLocalModels = false;
            env.useBrowserCache = true;

            // Pin onnxruntime-web's WASM/JSEP glue to the exact nightly we use
            // in the import map. Without this, transformers.js builds the path
            // from ONNX_ENV.versions.web which can drift, and the JSEP glue
            // (ort-wasm-simd-threaded.jsep.mjs) fails to load — in which case
            // Module.webgpuInit is never attached and the WebGPU backend errors
            // with: "z().webgpuInit is not a function".
            const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/';
            if (env.backends?.onnx?.wasm) {
                env.backends.onnx.wasm.wasmPaths = ORT_DIST;
            }

            const fileProgress = {};
            const loggedFiles = new Set();
            const { dtype: modelDtype, device: modelDevice } = getModelConfig();
            console.log(`[STT] Using device: ${modelDevice}, dtype:`, modelDtype);

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
            registerLoadedModel('stt', disposeSTTModel, { sizeMB });

            // Pre-warm the pipeline: run one inference on 1 s of silence so all
            // ONNX kernels are JIT-compiled now (during loading state) instead
            // of during the first live chunk — the source of the "hang at first
            // transcribe" complaint. Bounded by a 60 s timeout in case warm-up
            // itself stalls (we then just continue without warm; live loop will
            // pay the cost on its own first chunk).
            isPipelineWarm = false;
            try {
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
                console.warn('[STT] pre-warm failed (continuing anyway):', warmErr);
                isPipelineWarm = true; // allow inference even if warm-up didn't finish; first real chunk will compile
            }

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

// ── Live PCM Capture ───────────────────────────────────────────────────────────
async function setupPCMCapture(stream) {
    liveAudioCtx = new AudioContext({ sampleRate: 16000 });
    liveSampleRate = liveAudioCtx.sampleRate;
    liveSourceNode = liveAudioCtx.createMediaStreamSource(stream);

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
        await liveAudioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        liveProcessorNode = new AudioWorkletNode(liveAudioCtx, 'pcm-cap');
        liveProcessorNode.port.onmessage = (e) => {
            pcmChunks.push(e.data);
            pcmSampleCount += e.data.length;
        };
        liveSourceNode.connect(liveProcessorNode);
        console.log('[STT] PCM capture via AudioWorklet at', liveSampleRate, 'Hz');
    } catch (err) {
        console.warn('[STT] AudioWorklet unavailable, using ScriptProcessor fallback:', err.message);
        const proc = liveAudioCtx.createScriptProcessorNode(4096, 1, 1);
        proc.onaudioprocess = (e) => {
            const data = new Float32Array(e.inputBuffer.getChannelData(0));
            pcmChunks.push(data);
            pcmSampleCount += data.length;
        };
        liveSourceNode.connect(proc);
        const silentGain = liveAudioCtx.createGain();
        silentGain.gain.value = 0;
        proc.connect(silentGain);
        silentGain.connect(liveAudioCtx.destination);
        liveProcessorNode = proc;
        console.log('[STT] PCM capture via ScriptProcessor at', liveSampleRate, 'Hz');
    }
}

function collectPCMRange(fromSample, toSample) {
    let offset = 0;
    const parts = [];
    for (const chunk of pcmChunks) {
        const chunkEnd = offset + chunk.length;
        if (chunkEnd > fromSample && offset < toSample) {
            const start = Math.max(0, fromSample - offset);
            const end = Math.min(chunk.length, toSample - offset);
            parts.push(chunk.subarray(start, end));
        }
        offset = chunkEnd;
        if (offset >= toSample) break;
    }
    const totalLen = parts.reduce((a, c) => a + c.length, 0);
    const result = new Float32Array(totalLen);
    let pos = 0;
    for (const part of parts) { result.set(part, pos); pos += part.length; }
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

// Hard ceiling on a single inference. If it doesn't return in this long,
// the chunk is abandoned (advance the cursor, log a warning) so the live
// loop never deadlocks. Picked generously — a healthy WASM inference on
// whisper-small for 20 s of audio is ~3–8 s on modern desktops.
const LIVE_INFER_TIMEOUT_MS = 90000;

async function transcribeLiveChunk() {
    if (!pipeline || !isPipelineWarm || isChunkBusy) return;
    const currentCount = pcmSampleCount;
    if (currentCount <= lastProcessedSample) return;
    const newSamples = currentCount - lastProcessedSample;
    if (newSamples < liveSampleRate * MIN_CHUNK_SECONDS) return;

    // Cap chunk size so a slow inference can't snowball into a giant blob
    // that looks like the app has "hung". If audio has piled up, we just
    // process the next MAX_CHUNK_SECONDS and let the loop pick up the rest.
    const maxSamples = Math.floor(liveSampleRate * MAX_CHUNK_SECONDS);
    const chunkEnd = Math.min(currentCount, lastProcessedSample + maxSamples);

    isChunkBusy = true;
    if (sttLiveStatus) sttLiveStatus.textContent = 'Transcribing…';
    try {
        let chunkData = collectPCMRange(lastProcessedSample, chunkEnd);
        if (liveSampleRate !== 16000) chunkData = resampleTo16k(chunkData, liveSampleRate);

        // Skip silent chunks — avoids hallucinations on silence
        if (isAudioSilent(chunkData)) {
            lastProcessedSample = chunkEnd;
            return;
        }

        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';
        // Yield to event loop so the UI/waveform stays responsive
        await new Promise(r => setTimeout(r, 0));
        const t0 = performance.now();
        // Race inference against a hard timeout so a stuck call can't freeze
        // the live loop. On timeout we drop the chunk and advance the cursor;
        // the stuck promise will eventually resolve and be ignored.
        const inferPromise = pipeline(chunkData, {
            language,
            task: 'transcribe',
            return_timestamps: false,
        });
        let timeoutId;
        const timeoutPromise = new Promise((_, rej) => {
            timeoutId = setTimeout(() => rej(new Error('inference timeout')), LIVE_INFER_TIMEOUT_MS);
        });
        let result;
        try {
            result = await Promise.race([inferPromise, timeoutPromise]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
        lastInferenceMs = performance.now() - t0;
        const text = (result && result.text || '').trim();
        if (text && !isHallucination(text)) {
            liveSegments.push(text);
            updateLiveDisplay();
        }
        lastProcessedSample = chunkEnd;
    } catch (err) {
        console.error('[STT] Live chunk error:', err);
        // Advance the cursor regardless so we don't retry the same broken chunk
        // forever (which is the classic "transcribing… hangs" symptom).
        lastProcessedSample = chunkEnd;
    } finally {
        isChunkBusy = false;
        if (sttLiveStatus && isRecording) sttLiveStatus.textContent = 'Listening…';
    }
}

function updateLiveDisplay() {
    const text = liveSegments.join(' ');
    if (sttLiveText) sttLiveText.textContent = text;
    transcriptionResult = text;
    renderSTTResults(text);
    if (sttResults) sttResults.style.display = 'block';
    // Auto-scroll the live text container
    const container = sttLiveText?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
}

function startLiveLoop() {
    // Adaptive loop: waits for inference to finish, then cools down
    // based on how long inference took (slower machine = longer pause)
    async function loop() {
        if (!isRecording) return;
        if (!isChunkBusy) {
            await transcribeLiveChunk();
        }
        // Cooldown = max(MIN_COOLDOWN, inference time), so the CPU gets a breather
        const cooldown = Math.max(MIN_COOLDOWN_MS, lastInferenceMs);
        liveInterval = setTimeout(loop, cooldown);
    }
    liveInterval = setTimeout(loop, MIN_COOLDOWN_MS);
}

async function cleanupLiveCapture() {
    if (liveInterval) { clearTimeout(liveInterval); liveInterval = null; }
    if (liveSourceNode) { try { liveSourceNode.disconnect(); } catch (_) {} liveSourceNode = null; }
    if (liveProcessorNode) { try { liveProcessorNode.disconnect(); } catch (_) {} liveProcessorNode = null; }
    if (liveAudioCtx && liveAudioCtx.state !== 'closed') {
        try { await liveAudioCtx.close(); } catch (_) {}
    }
    liveAudioCtx = null;
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
    // 3. If permission was previously denied at the browser level, getUserMedia rejects
    //    immediately without showing a prompt. Surface that clearly.
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const p = await navigator.permissions.query({ name: 'microphone' });
            if (p && p.state === 'denied') {
                report('Microphone permission was previously denied for this site. Click the lock/info icon in the address bar → Site settings → set Microphone to “Allow” (or “Ask”), then reload.', 'error');
                return null;
            }
        }
    } catch (_) { /* permissions.query for "microphone" is unsupported in some browsers — ignore */ }

    try {
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
    if (isRecording) return;

    const report = (msg, _kind) => {
        if (sttLiveStatus) {
            if (sttLiveTranscript) sttLiveTranscript.style.display = 'block';
            sttLiveStatus.textContent = msg;
        }
    };

    // 1. Acquire mic FIRST — keeps us inside the user-gesture window so the
    //    permission prompt is guaranteed to appear (model load can take seconds).
    if (sttRecordBtn) sttRecordBtn.disabled = true;
    const stream = await acquireMicStream(report);
    if (!stream) {
        if (sttRecordBtn) sttRecordBtn.disabled = false;
        return;
    }

    try {
        // 2. Now load the model.
        report('Loading model...', 'info');
        await initSTTModel();
        if (sttRecordBtn) sttRecordBtn.disabled = false;

        audioChunks = [];
        recordedBlob = null;
        liveSegments = [];
        pcmChunks = [];
        pcmSampleCount = 0;
        lastProcessedSample = 0;
        transcriptionResult = null;

        // MediaRecorder for final blob (re-transcription / download)
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
            recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
        };

        // Set up raw PCM capture for live transcription
        await setupPCMCapture(stream);

        // Set up waveform visualizer
        startWaveform(stream, sttWaveformCanvas, 'stt');

        mediaRecorder.start(1000);
        isRecording = true;

        // UI: show recording state
        if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'flex';
        if (sttRecordBtn) sttRecordBtn.style.display = 'none';
        if (sttStopBtn) sttStopBtn.style.display = '';
        if (sttResults) sttResults.style.display = 'none';
        if (sttLiveTranscript) sttLiveTranscript.style.display = 'block';
        if (sttLiveText) sttLiveText.textContent = '';
        if (sttLiveStatus) sttLiveStatus.textContent = 'Listening...';
        if (sttWaveformCanvas) sttWaveformCanvas.style.display = 'block';

        // Model is already loaded — start live transcription loop immediately
        startLiveLoop();
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

    // Stop MediaRecorder
    const stream = mediaRecorder?.stream;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }

    // Clean up PCM capture
    await cleanupLiveCapture();

    // Stop waveform
    stopWaveform('stt');

    // Stop mic stream
    if (stream) stream.getTracks().forEach(t => t.stop());

    // UI
    if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'none';
    if (sttRecordBtn) sttRecordBtn.style.display = '';
    if (sttStopBtn) sttStopBtn.style.display = 'none';
    if (sttWaveformCanvas) sttWaveformCanvas.style.display = 'none';

    // Transcribe any remaining audio
    if (pipeline && pcmSampleCount > lastProcessedSample) {
        if (sttLiveStatus) sttLiveStatus.textContent = 'Finalizing...';
        await transcribeLiveChunk();
    }

    // Hide live area
    if (sttLiveTranscript) sttLiveTranscript.style.display = 'none';

    // Show final result
    if (liveSegments.length > 0) {
        transcriptionResult = liveSegments.join(' ');
        renderSTTResults(transcriptionResult);
        if (sttResults) sttResults.style.display = 'block';
    }

    // Enable re-transcription from blob
    if (sttFileInfo) {
        sttFileInfo.style.display = 'block';
        if (sttFileName) sttFileName.textContent = 'Recorded audio';
    }
    if (transcribeBtn) transcribeBtn.disabled = false;
}

// ── Audio Processing ───────────────────────────────────────────────────────────
async function decodeAudioToFloat32(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0); // mono
    audioContext.close();
    return channelData;
}

// ── Transcription ──────────────────────────────────────────────────────────────
async function performTranscription() {
    if (isTranscribing || !recordedBlob) return;

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

        const audioData = await decodeAudioToFloat32(recordedBlob);

        if (sttProgressText) sttProgressText.textContent = 'Transcribing...';
        if (sttProgressBar) sttProgressBar.style.width = '50%';
        updateStatus('translating', 'Transcribing audio...');

        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';

        // Hard timeout so a hung WASM/WebGPU inference can't freeze the UI.
        // 10 minutes is generous — whisper-small on a 30-minute file under
        // WASM lands well under that.
        const FILE_INFER_TIMEOUT_MS = 10 * 60 * 1000;
        const inferPromise = pipeline(audioData, {
            language,
            task: 'transcribe',
            chunk_length_s: isMobile ? 15 : 30,
            stride_length_s: isMobile ? 3 : 5,
            return_timestamps: true,
        });
        let timeoutId;
        const timeoutPromise = new Promise((_, rej) => {
            timeoutId = setTimeout(() => rej(new Error('inference timeout after 10 minutes — try a shorter clip or the Whisper Tiny model')), FILE_INFER_TIMEOUT_MS);
        });
        let result;
        try {
            result = await Promise.race([inferPromise, timeoutPromise]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        if (sttProgressBar) sttProgressBar.style.width = '100%';
        if (sttProgressText) sttProgressText.textContent = 'Transcription complete ✓';

        transcriptionResult = formatTimestampedResult(result);
        renderSTTResults(transcriptionResult);
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
        if (!liveAudioCtx) return;
        audioCtx = liveAudioCtx;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        liveSourceNode.connect(analyser);
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
    dictaphoneAudioCtx = new AudioContext({ sampleRate: 16000 });
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
        const proc = dictaphoneAudioCtx.createScriptProcessorNode(4096, 1, 1);
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

        // MediaRecorder backup
        dictaphoneMediaRec = new MediaRecorder(dictaphoneStream, { mimeType: 'audio/webm;codecs=opus' });
        dictaphoneMediaRec.ondataavailable = (e) => {
            if (e.data.size > 0) dictaphoneChunks.push(e.data);
        };
        dictaphoneMediaRec.start(500);

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
        const rate = 16000; // dictaphone audioCtx was created at 16kHz
        if (rate !== 16000) audioData = resampleTo16k(audioData, rate);
        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';
        // Skip silent audio
        if (isAudioSilent(audioData)) {
            entry.text = '(no speech detected)';
            renderDictLog();
            return;
        }
        const result = await pipeline(audioData, {
            language,
            task: 'transcribe',
            return_timestamps: false,
        });
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
        liveSegments = [];
        pcmChunks = [];
        pcmSampleCount = 0;
        lastProcessedSample = 0;
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
