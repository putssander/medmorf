// Offline Speech-to-Text — Whisper via Transformers.js (WebAssembly/WebGPU)
// Uses whisper-small or whisper-tiny for browser-based transcription.
// Zero data leaves the browser — all processing is local.

const BUILD_ID = window.MEDMORF_BUILD_ID || 'unknown-build';
console.log('[BUILD] stt-handler.js build', BUILD_ID, 'module url', import.meta.url);

// ── Model Options ──────────────────────────────────────────────────────────────
const STT_MODEL_OPTIONS = {
    'onnx-community/whisper-tiny': {
        id: 'onnx-community/whisper-tiny',
        label: 'Whisper Tiny',
        size: '~150 MB',
        description: 'Fastest, lowest resource usage. Good for short recordings.',
        quality: 'Basic',
    },
    'onnx-community/whisper-small': {
        id: 'onnx-community/whisper-small',
        label: 'Whisper Small',
        size: '~500 MB',
        description: 'Best balance of speed and accuracy. Recommended.',
        quality: 'Good',
    },
    'onnx-community/whisper-base': {
        id: 'onnx-community/whisper-base',
        label: 'Whisper Base',
        size: '~300 MB',
        description: 'Middle ground between tiny and small.',
        quality: 'Fair',
    },
};

const DEFAULT_STT_MODEL = 'onnx-community/whisper-small';

// ── State ──────────────────────────────────────────────────────────────────────
let pipeline = null;
let loadedModelId = null;
let isModelLoading = false;
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
const LIVE_CHUNK_INTERVAL = 10000;
const MIN_CHUNK_SECONDS = 2;

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

function updateStatus(state, message) {
    if (systemStatusIndicator) systemStatusIndicator.className = `status-indicator ${state}`;
    if (systemStatusText) systemStatusText.textContent = message;
}

// ── Populate Selects ───────────────────────────────────────────────────────────
function populateSTTModelSelect() {
    if (!sttModelSelect) return;
    sttModelSelect.innerHTML = '';
    for (const [id, opt] of Object.entries(STT_MODEL_OPTIONS)) {
        const el = document.createElement('option');
        el.value = id;
        el.textContent = `${opt.label} (${opt.size})`;
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

async function initSTTModel() {
    const selectedModel = getSelectedModel();
    if (pipeline && loadedModelId === selectedModel) return;
    if (isModelLoading) return;

    if (pipeline) {
        await disposeSTTModel();
    }

    isModelLoading = true;
    if (sttModelStatus) sttModelStatus.style.display = 'block';
    if (sttModelProgress) sttModelProgress.style.width = '0%';

    const modelLabel = STT_MODEL_OPTIONS[selectedModel]?.label || selectedModel;
    const sttModelHeading = document.getElementById('sttModelHeading');
    if (sttModelHeading) sttModelHeading.textContent = `Loading ${modelLabel}...`;
    if (sttModelStatusText) sttModelStatusText.textContent = `Initializing ${modelLabel}...`;
    updateStatus('loading', `Loading ${modelLabel}...`);

    try {
        const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        const fileProgress = {};
        const loggedFiles = new Set();

        pipeline = await createPipeline('automatic-speech-recognition', selectedModel, {
            dtype: 'q8',
            device: 'wasm',
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
                } else if (progress.status === 'done') {
                    if (sttModelStatusText) sttModelStatusText.textContent = `Initializing ${modelLabel}...`;
                }
            },
        });

        if (sttModelStatusText) sttModelStatusText.textContent = `${modelLabel} loaded ✓`;
        if (sttModelProgress) sttModelProgress.style.width = '100%';
        loadedModelId = selectedModel;
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

async function transcribeLiveChunk() {
    if (!pipeline || isChunkBusy) return;
    const currentCount = pcmSampleCount;
    if (currentCount <= lastProcessedSample) return;
    const newSamples = currentCount - lastProcessedSample;
    if (newSamples < liveSampleRate * MIN_CHUNK_SECONDS) return;

    isChunkBusy = true;
    if (sttLiveStatus) sttLiveStatus.textContent = 'Transcribing chunk...';
    try {
        let chunkData = collectPCMRange(lastProcessedSample, currentCount);
        if (liveSampleRate !== 16000) chunkData = resampleTo16k(chunkData, liveSampleRate);
        const language = sttLanguageSelect ? sttLanguageSelect.value : 'nl';
        const result = await pipeline(chunkData, {
            language,
            task: 'transcribe',
            return_timestamps: false,
        });
        const text = (result.text || '').trim();
        if (text) {
            liveSegments.push(text);
            updateLiveDisplay();
        }
        lastProcessedSample = currentCount;
    } catch (err) {
        console.error('[STT] Live chunk error:', err);
    } finally {
        isChunkBusy = false;
        if (sttLiveStatus && isRecording) sttLiveStatus.textContent = 'Listening...';
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
    liveInterval = setInterval(() => {
        if (!isRecording || isChunkBusy) return;
        transcribeLiveChunk();
    }, LIVE_CHUNK_INTERVAL);
}

async function cleanupLiveCapture() {
    if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
    if (liveSourceNode) { try { liveSourceNode.disconnect(); } catch (_) {} liveSourceNode = null; }
    if (liveProcessorNode) { try { liveProcessorNode.disconnect(); } catch (_) {} liveProcessorNode = null; }
    if (liveAudioCtx && liveAudioCtx.state !== 'closed') {
        try { await liveAudioCtx.close(); } catch (_) {}
    }
    liveAudioCtx = null;
}

// ── Audio Recording ────────────────────────────────────────────────────────────
async function startRecording() {
    if (isRecording) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

        mediaRecorder.start(1000);
        isRecording = true;

        // UI: show recording state
        if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'flex';
        if (sttRecordBtn) sttRecordBtn.style.display = 'none';
        if (sttStopBtn) sttStopBtn.style.display = '';
        if (sttResults) sttResults.style.display = 'none';
        if (sttLiveTranscript) sttLiveTranscript.style.display = 'block';
        if (sttLiveText) sttLiveText.textContent = '';
        if (sttLiveStatus) sttLiveStatus.textContent = 'Loading model...';

        // Preload Whisper model, then begin live transcription loop
        try {
            await initSTTModel();
            if (isRecording) {
                if (sttLiveStatus) sttLiveStatus.textContent = 'Listening...';
                startLiveLoop();
            }
        } catch (err) {
            console.error('[STT] Model preload failed:', err);
            if (sttLiveStatus) sttLiveStatus.textContent = 'Model unavailable — transcribe after recording';
        }
    } catch (error) {
        console.error('Microphone access error:', error);
        alert('Could not access microphone. Please allow microphone permission.');
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

    // Stop mic stream
    if (stream) stream.getTracks().forEach(t => t.stop());

    // UI
    if (sttRecordingIndicator) sttRecordingIndicator.style.display = 'none';
    if (sttRecordBtn) sttRecordBtn.style.display = '';
    if (sttStopBtn) sttStopBtn.style.display = 'none';

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

        const result = await pipeline(audioData, {
            language,
            task: 'transcribe',
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: false,
        });

        if (sttProgressBar) sttProgressBar.style.width = '100%';
        if (sttProgressText) sttProgressText.textContent = 'Transcription complete ✓';

        transcriptionResult = result.text || '';
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
            await disposeSTTModel();
        }
    });
});

// Expose for privacy inspector
window.medmorfSTTData = {
    hasRecording: () => recordedBlob !== null,
    hasResult: () => transcriptionResult !== null,
    clearAll: async () => {
        if (isRecording) await stopRecording();
        recordedBlob = null;
        transcriptionResult = null;
        audioChunks = [];
        liveSegments = [];
        pcmChunks = [];
        pcmSampleCount = 0;
        lastProcessedSample = 0;
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
