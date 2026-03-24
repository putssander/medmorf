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
        if (sttLiveStatus) sttLiveStatus.textContent = 'Loading model...';
        if (sttWaveformCanvas) sttWaveformCanvas.style.display = 'block';

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

        const result = await pipeline(audioData, {
            language,
            task: 'transcribe',
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: true,
        });

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

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        const id = requestAnimationFrame(draw);
        if (target === 'stt') waveformAnimId = id;
        else dictaphoneWaveAnimId = id;

        analyser.getByteTimeDomainData(dataArray);

        const w = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
        const h = canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
        ctx.clearRect(0, 0, w, h);

        ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
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
    draw();
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

    try {
        if (!dictaphoneStream) {
            dictaphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
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
    } catch (error) {
        console.error('Dictaphone mic error:', error);
        alert('Could not access microphone.');
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

    // Get PCM audio
    const pcmData = collectDictaphonePCM();

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
        pcmData: pcmData,
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
        const result = await pipeline(audioData, {
            language,
            task: 'transcribe',
            return_timestamps: false,
        });
        entry.text = (result.text || '').trim() || '(no speech detected)';
    } catch (err) {
        console.error('[DICT] Transcription error:', err);
        entry.text = '(transcription failed)';
    }
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

// Expose for privacy inspector
window.medmorfSTTData = {
    hasRecording: () => recordedBlob !== null,
    hasResult: () => transcriptionResult !== null,
    hasDictaphoneEntries: () => dictaphoneEntries.length > 0,
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
