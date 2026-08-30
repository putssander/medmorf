// benchmark-handler.js
// In-app model benchmark (Benchmark tab) — also driven standalone by
// tests/test-models.html. Loads every model option per tab plus Qwen3.5
// candidates on the synthetic fixtures in tests/fixtures/, and records load
// time, inference time, peak JS heap delta and a task quality score
// (tests/metrics.js). Runs are serialised through the app's heavy-load lock
// and shown on the memory bar while a model is resident.
import { wer, chrF, scorePII, scoreFacts, mean } from '../tests/metrics.js';
import { getCapabilities, safeModelCeilingMB, getRuntimeMemorySnapshot } from './device-capabilities.js?v=2026-05-28-resource-1';
import { detectBrowser } from './memory-monitor.js?v=2026-08-30-memory-bar-3';
import { withHeavyLoadLock } from './pre-flight-warn.js?v=2026-08-30-memory-bar-2';
import { NER_MODEL_OPTIONS, initNERPipeline, disposeNERPipeline, getNERPipeline, getGLiNERInstance, isGLiNERModel, mapNEREntityType } from './privacy-runtime.js?v=2026-08-30-memory-bar-2';
import { TRANSLATION_MODEL, TRANSLATION_MODEL_SIZE_MB, initTranslationPipeline, disposeTranslationPipeline } from './translation-runtime.js?v=2026-08-30-memory-bar-2';
import { SYSTEM_PROMPT } from './anonymize-prompts.js?v=2026-08-30-memory-bar-2';

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/lib/index.js';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/';

// Browser-feasible Qwen options (≤4B). The app ships Qwen3.5 only; Qwen3 rows are kept here as reference baselines.
// 8B/9B are deliberately excluded: they exceed every per-tab memory guardrail.
const LLM_MODELS = [
    { id: 'Qwen3-0.6B-q4f16_1-MLC',   label: 'Qwen3 0.6B',   sizeMB: 1400, inApp: false },
    { id: 'Qwen3.5-0.8B-q4f16_1-MLC', label: 'Qwen3.5 0.8B', sizeMB: 1630, inApp: true },
    { id: 'Qwen3-1.7B-q4f16_1-MLC',   label: 'Qwen3 1.7B',   sizeMB: 2000, inApp: false },
    { id: 'Qwen3.5-2B-q4f16_1-MLC',   label: 'Qwen3.5 2B',   sizeMB: 2250, inApp: true, appDefault: 'anonymize + summarize' },
    { id: 'Qwen3-4B-q4f16_1-MLC',     label: 'Qwen3 4B',     sizeMB: 3400, inApp: false },
    { id: 'Qwen3.5-4B-q4f16_1-MLC',   label: 'Qwen3.5 4B',   sizeMB: 3870, inApp: true },
];
const STT_MODELS = [
    { id: 'onnx-community/whisper-tiny',  label: 'Whisper tiny',  sizeMB: 150 },
    { id: 'onnx-community/whisper-base',  label: 'Whisper base',  sizeMB: 300 },
    { id: 'onnx-community/whisper-small', label: 'Whisper small', sizeMB: 500, appDefault: 'desktop' },
];

const fixtures = {};
const results = [];   // flat list of result records, exported as JSON
let snap = null, webllm = null, transformers = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
let root = document;
const $ = (s) => root.querySelector(s);
const log = (...a) => { const el = $('#bmLog'); el.textContent += a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'; el.scrollTop = el.scrollHeight; console.log('[bench]', ...a); };
const fmtMB = (mb) => mb == null || !isFinite(mb) ? '—' : mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
const fmtMs = (ms) => ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
const pct = (x) => isFinite(x) ? (x * 100).toFixed(0) + '%' : '—';
const yieldUI = () => new Promise(r => setTimeout(r, 0));

// Heap sampler: peak usedJSHeapSize while a test runs (Chromium only).
function heapSampler() {
    const m = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);
    const base = m();
    let peak = base ?? 0;
    const t = base == null ? null : setInterval(() => { peak = Math.max(peak, m()); }, 200);
    return {
        supported: base != null,
        base,
        stop() { if (t) clearInterval(t); const now = m(); return { base, peak: Math.max(peak, now ?? 0), end: now, deltaPeak: base == null ? null : Math.max(peak, now) - base }; },
    };
}
async function gc() { await yieldUI(); if (typeof window.gc === 'function') window.gc(); await new Promise(r => setTimeout(r, 300)); }

// ── Table rendering ──────────────────────────────────────────────────────────
const COLS = { model: 'Model', size: 'Declared', load: 'Load', infer: 'Inference', heap: 'Peak heap Δ', quality: 'Quality', detail: 'Detail' };
function buildTable(section, rows) {
    const tbl = $(`#tbl-${section}`);
    tbl.innerHTML = `<thead><tr><th></th>${Object.values(COLS).map(c => `<th>${c}</th>`).join('')}<th></th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    for (const r of rows) {
        const tr = document.createElement('tr');
        tr.id = `row-${section}-${cssId(r.id)}`;
        tr.innerHTML = `<td><input type="checkbox" checked data-sel></td>
            <td><b>${r.label}</b><br><span class="bm-detail">${r.id}</span> ${r.inApp === false ? '<span class="bm-tag new">reference only</span>' : ''}${r.appDefault ? `<span class="bm-tag">app default (${r.appDefault})</span>` : ''}${r.webgpu ? '<span class="bm-tag gpu">WebGPU</span>' : ''}</td>
            <td class="bm-num">${fmtMB(r.sizeMB)}</td><td class="bm-num">—</td><td class="bm-num">—</td><td class="bm-num">—</td><td class="bm-num">—</td><td class="bm-detail">Idle.</td>
            <td><button class="btn btn-ghost btn-small" data-one="${section}|${r.id}">Run</button></td>`;
        tb.appendChild(tr);
    }
}
const cssId = (s) => s.replace(/[^a-z0-9]/gi, '_');
function setRow(section, id, { status, load, infer, heap, quality, detail }) {
    const tr = $(`#row-${section}-${cssId(id)}`); if (!tr) return;
    tr.className = status ? 'bm-' + status : '';
    const td = tr.querySelectorAll('td');
    if (load !== undefined) td[3].textContent = fmtMs(load);
    if (infer !== undefined) td[4].textContent = fmtMs(infer);
    if (heap !== undefined) td[5].textContent = heap;
    if (quality !== undefined) td[6].textContent = quality;
    if (detail !== undefined) td[7].textContent = detail;
}
function selectedIds(section) {
    return Array.from(root.querySelectorAll(`#tbl-${section} tbody tr`)).filter(tr => tr.querySelector('[data-sel]').checked).map(tr => tr.id.replace(`row-${section}-`, ''));
}
function record(rec) { results.push({ ts: new Date().toISOString(), ...rec }); }

// ── Generic runner ───────────────────────────────────────────────────────────
// spec: { section, id, label, sizeMB, load: async () => handle, infer: async (handle, doc) => {output, score}, dispose: async (handle) => void, docs: [] }
async function runModel(spec) {
    // Serialise with the app's own heavy loads; the lock's sizeMB also puts the model on the memory bar while it runs.
    return withHeavyLoadLock(`Benchmark: ${spec.label}`, () => runModelInner(spec), { sizeMB: spec.sizeMB });
}
async function runModelInner(spec) {
    const { section, id } = spec;
    const skipBig = $('#bmSkipBig').checked;
    const ceiling = safeModelCeilingMB(snap);
    if (skipBig && spec.sizeMB > ceiling) {
        setRow(section, id, { status: 'skip', detail: `Skipped: ${fmtMB(spec.sizeMB)} > safe ceiling ${fmtMB(ceiling)} for this device (uncheck "Skip models above…" to force).` });
        record({ section, model: id, status: 'skipped', reason: 'above-ceiling', sizeMB: spec.sizeMB, ceilingMB: ceiling });
        return;
    }
    setRow(section, id, { status: 'run', detail: 'Loading…', load: undefined, infer: undefined, heap: undefined, quality: undefined });
    await gc();
    const sampler = heapSampler();
    const rec = { section, model: id, label: spec.label, sizeMB: spec.sizeMB, docs: [] };
    let handle = null;
    const t0 = performance.now();
    try {
        handle = await spec.load((msg) => setRow(section, id, { detail: msg }));
        rec.loadMs = performance.now() - t0;
        const heapAfterLoad = sampler.stop(); // snapshot after load
        rec.heapAfterLoadMB = heapAfterLoad.deltaPeak;
        const sampler2 = heapSampler();
        const docs = spec.docs.slice(0, Number($('#bmNumDocs').value) || 4);
        const t1 = performance.now();
        for (let i = 0; i < docs.length; i++) {
            setRow(section, id, { load: rec.loadMs, detail: `Inference ${i + 1}/${docs.length}…` });
            const td = performance.now();
            const { output, score } = await spec.infer(handle, docs[i]);
            rec.docs.push({ id: docs[i].id, ms: performance.now() - td, score, output: typeof output === 'string' ? output.slice(0, 4000) : output });
            $('#bmLastOut').value = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
            await yieldUI();
        }
        rec.inferMs = performance.now() - t1;
        rec.inferMsPerDoc = rec.inferMs / Math.max(1, docs.length);
        const h = sampler2.stop();
        rec.heapPeakDeltaMB = Math.max(h.deltaPeak ?? 0, rec.heapAfterLoadMB ?? 0);
        rec.heapSupported = sampler.supported;
        rec.quality = spec.aggregate(rec.docs.map(d => d.score));
        rec.status = 'pass';
        setRow(section, id, { status: 'pass', load: rec.loadMs, infer: rec.inferMsPerDoc, heap: sampler.supported ? '+' + fmtMB(rec.heapPeakDeltaMB) : 'n/a (browser)', quality: rec.quality.label, detail: rec.quality.detail });
    } catch (err) {
        rec.status = 'fail';
        rec.error = `${err.name}: ${err.message}`;
        rec.loadMs ??= performance.now() - t0;
        const h = sampler.stop();
        rec.heapPeakDeltaMB = h.deltaPeak;
        setRow(section, id, { status: 'fail', load: rec.loadMs, heap: sampler.supported ? '+' + fmtMB(h.deltaPeak) : 'n/a', quality: '—', detail: rec.error });
        log('FAIL', id, rec.error);
    } finally {
        try { await spec.dispose(handle); } catch (e) { log('dispose failed', id, e.message); }
        await gc();
        const after = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
        rec.heapAfterDisposeMB = after != null && sampler.base != null ? after - sampler.base : null;
        record(rec);
    }
}

// ── Section: Translate ───────────────────────────────────────────────────────
function translateSpecs() {
    const f = fixtures.translate;
    return [{
        section: 'translate', id: TRANSLATION_MODEL, label: 'NLLB-200 distilled 600M', sizeMB: TRANSLATION_MODEL_SIZE_MB,
        docs: [{ id: 'all-pairs', pairs: f.pairs }],
        load: async (progress) => initTranslationPipeline({ skipPreflight: true, progressCallback: (p) => p.status === 'progress' && progress(`Downloading ${p.file || ''} ${Math.round(p.progress || 0)}%`) }),
        infer: async (pipe, doc) => {
            const outs = [];
            for (const p of doc.pairs) {
                const r = await pipe(p.nl, { src_lang: f.src_lang, tgt_lang: f.tgt_lang });
                const hyp = Array.isArray(r) ? r[0]?.translation_text : r?.translation_text;
                outs.push({ id: p.id, nl: p.nl, ref: p.en, hyp, chrF: chrF(p.en, hyp) });
            }
            return { output: outs, score: mean(outs.map(o => o.chrF)) };
        },
        dispose: () => disposeTranslationPipeline(),
        aggregate: (scores) => ({ value: mean(scores), label: `chrF ${pct(mean(scores))}`, detail: `${f.pairs.length} NL→EN sentences. chrF ≥ 60% is good for a 600M model.` }),
    }];
}

// ── Section: NER ─────────────────────────────────────────────────────────────
function nerSpecs() {
    const docs = fixtures.anonymize.documents;
    return Object.values(NER_MODEL_OPTIONS).map(opt => ({
        section: 'ner', id: opt.id, label: opt.label, sizeMB: opt.sizeMB, webgpu: opt.device === 'webgpu' || opt.wasmSupported === false, docs,
        load: async (progress) => {
            if ((opt.device === 'webgpu' || opt.wasmSupported === false) && !snap.webgpu.supported) throw new Error('Requires WebGPU (not available)');
            await initNERPipeline({ modelId: opt.id, progressCallback: (p) => p.status === 'progress' && progress(`Downloading ${p.file || ''} ${p.total ? Math.round(p.loaded / p.total * 100) : ''}%`) });
            return opt.id;
        },
        infer: async (modelId, doc) => {
            let preds;
            if (isGLiNERModel(modelId)) {
                const g = getGLiNERInstance();
                const res = await g.inference({ texts: [doc.text], entities: opt.piiLabels, flatNer: true, threshold: 0.3 });
                preds = (res[0] || []).map(e => ({ entity: e.spanText ?? e.text ?? doc.text.slice(e.start, e.end), type: mapNEREntityType(e.label, modelId) }));
            } else {
                const pipe = getNERPipeline();
                const toks = await pipe(doc.text, { ignore_labels: ['O'] });
                preds = mergeTokens(toks, doc.text).map(e => ({ entity: e.word, type: mapNEREntityType(e.entity, modelId) }));
            }
            const score = scorePII(doc.pii, preds, doc.allowed);
            return { output: { predictions: preds, missed: score.missed, falsePositives: score.falsePositives }, score };
        },
        dispose: () => disposeNERPipeline(),
        aggregate: piiAggregate,
    }));
}
// Merge B-/I- token pieces into spans (mirrors the app's aggregation closely enough for overlap scoring).
function mergeTokens(toks, text) {
    const out = [];
    for (const t of toks) {
        const label = String(t.entity || t.entity_group || '');
        const base = label.replace(/^[BI]-/, '');
        const word = String(t.word || '').replace(/^##/, '');
        const last = out[out.length - 1];
        const cont = last && (label.startsWith('I-') || String(t.word || '').startsWith('##')) && last.entity === base;
        if (cont) last.word += (String(t.word || '').startsWith('##') || /^[^\w]/.test(word) ? '' : ' ') + word;
        else out.push({ word, entity: base });
    }
    return out.filter(e => e.word.trim().length > 1);
}
function piiAggregate(scores) {
    const recall = mean(scores.map(s => s.recall)), precision = mean(scores.map(s => s.precision));
    const perType = {};
    for (const s of scores) for (const [t, v] of Object.entries(s.perType)) { perType[t] ??= { total: 0, detected: 0 }; perType[t].total += v.total; perType[t].detected += v.detected; }
    const worst = Object.entries(perType).map(([t, v]) => `${t} ${v.detected}/${v.total}`).join(', ');
    return { value: recall, recall, precision, perType, label: `recall ${pct(recall)} · prec ${pct(precision)}`, detail: `Per type: ${worst}. Recall = leak-safety; a missed item is an un-redacted identifier.` };
}

// ── Section: Anonymize LLM ───────────────────────────────────────────────────
async function loadWebLLM() { webllm ??= await import(WEBLLM_URL); return webllm; }
function llmLoad(modelId) {
    return async (progress) => {
        if (!snap.webgpu.supported) throw new Error('Requires WebGPU (not available)');
        const w = await loadWebLLM();
        const cfg = w.prebuiltAppConfig.model_list.find(m => m.model_id === modelId);
        if (!cfg) throw new Error(`${modelId} not in WebLLM 0.2.83 prebuilt list`);
        progress(`Loading (WebLLM says VRAM ${fmtMB(cfg.vram_required_MB)}${cfg.low_resource_required ? ', low-resource ok' : ', NOT low-resource'})…`);
        const engine = await w.CreateMLCEngine(modelId, { initProgressCallback: (p) => progress(p.text?.slice(0, 120) || '') });
        engine.__vram = cfg.vram_required_MB; engine.__lowRes = cfg.low_resource_required;
        return engine;
    };
}
async function chat(engine, messages, opts) {
    // enable_thinking:false → Qwen3/Qwen3.5 skip the <think> block (otherwise Qwen3.5 burns the whole max_tokens budget reasoning and returns no JSON).
    const r = await engine.chat.completions.create({ messages, stream: false, extra_body: { enable_thinking: false }, ...opts });
    return (r.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
function anonLlmSpecs() {
    const docs = fixtures.anonymize.documents;
    return LLM_MODELS.map(m => ({
        section: 'anonllm', ...m, webgpu: true, docs,
        load: llmLoad(m.id),
        infer: async (engine, doc) => {
            const raw = await chat(engine, [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `Extract all PII entities from this medical text:\n\n${doc.text}` },
            ], { max_tokens: 2048, temperature: 0 });
            let preds = [];
            const j = raw.match(/\[[\s\S]*?\]/);
            if (j) { try { preds = JSON.parse(j[0]).filter(e => e && typeof e.entity === 'string'); } catch { /* unparsable */ } }
            const score = scorePII(doc.pii, preds, doc.allowed);
            score.parsed = !!j && preds.length > 0;
            return { output: { raw, missed: score.missed, falsePositives: score.falsePositives }, score };
        },
        dispose: async (engine) => { if (engine) await engine.unload(); },
        aggregate: (scores) => { const a = piiAggregate(scores); a.detail = `${a.detail} JSON parsed on ${scores.filter(s => s.parsed).length}/${scores.length} docs.`; return a; },
    }));
}

// ── Section: Summarize ───────────────────────────────────────────────────────
// Mirrors summarize-handler.js: (1) extractChunkFacts prompt, (2) freeform merge prompt.
function summarizeSpecs() {
    const docs = fixtures.summarize.documents;
    return LLM_MODELS.map(m => ({
        section: 'summarize', ...m, webgpu: true, docs,
        load: llmLoad(m.id),
        infer: async (engine, doc) => {
            const lang = doc.language;
            const facts = await chat(engine, [
                { role: 'system', content: `You are a clinical document analyst. Extract all clinically relevant facts from this document fragment. You MUST write in ${lang}.\n\nOutput a concise bullet-point list of key facts, observations, and details. Include: symptoms, diagnoses, timeline, medications, history, relationships, risk factors, coping strategies — anything clinically relevant.\n\nDo NOT output reasoning or thinking. Go straight to the bullet points.` },
                { role: 'user', content: `Extract key clinical facts from this text (part 1 of 1):\n\n${doc.text}` },
            ], { max_tokens: 1500, temperature: 0.1 });
            const summary = await chat(engine, [
                { role: 'system', content: `You are a clinical document summarization expert. Synthesize the extracted facts into a clear, comprehensive summary. You MUST write the entire report in ${lang}. All text, headings, and bullet points must be in ${lang}. Do NOT output reasoning or thinking.` },
                { role: 'user', content: `Synthesize these extracted facts into a coherent summary:\n\n${facts}` },
            ], { max_tokens: 1500, temperature: 0.1 });
            const score = scoreFacts(summary, doc.facts, doc.forbidden);
            return { output: `--- FACTS ---\n${facts}\n\n--- SUMMARY ---\n${summary}`, score };
        },
        dispose: async (engine) => { if (engine) await engine.unload(); },
        aggregate: (scores) => {
            const cov = mean(scores.map(s => s.coverage)), hal = mean(scores.map(s => s.hallucinationRate));
            return { value: cov, coverage: cov, hallucinationRate: hal, label: `facts ${pct(cov)} · halluc. ${pct(hal)}`, detail: `Missed: ${scores.flatMap(s => s.missed).slice(0, 6).join('; ') || 'none'}${scores.some(s => s.hallucinations.length) ? '\nHallucinated: ' + scores.flatMap(s => s.hallucinations).join('; ') : ''}` };
        },
    }));
}

// ── Section: STT ─────────────────────────────────────────────────────────────
async function loadTransformers() {
    if (transformers) return transformers;
    transformers = await import('@huggingface/transformers');
    transformers.env.allowLocalModels = false;
    transformers.env.useBrowserCache = true;
    transformers.env.backends.onnx.wasm.wasmPaths = ORT_WASM;
    return transformers;
}
async function decodeWav(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 16000 * 60, 16000);
    const audio = await ctx.decodeAudioData(buf);
    return audio.getChannelData(0);
}
function sttSpecs() {
    const clips = fixtures.speech.clips;
    const useGpu = () => $('#bmSttGpu').checked && snap.webgpu.supported;
    return STT_MODELS.map(m => ({
        section: 'stt', ...m, docs: clips,
        load: async (progress) => {
            const t = await loadTransformers();
            // Mirrors stt-handler.getModelConfig(): desktop WASM = encoder fp32 / decoder q4; GPU = fp16.
            const opts = useGpu()
                ? { dtype: 'fp16', device: 'webgpu' }
                : { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, device: 'wasm' };
            opts.progress_callback = (p) => p.status === 'progress' && progress(`Downloading ${p.file || ''} ${Math.round(p.progress || 0)}%`);
            return t.pipeline('automatic-speech-recognition', m.id, opts);
        },
        infer: async (pipe, clip) => {
            clip.__audio ??= await decodeWav(new URL(`../tests/fixtures/${clip.file}`, import.meta.url));
            const r = await pipe(clip.__audio, { language: clip.language, task: 'transcribe', chunk_length_s: 30 });
            const text = r?.text || '';
            const s = wer(clip.reference, text, clip.aliases);
            return { output: { transcript: text, reference: clip.reference }, score: { ...s, language: clip.language } };
        },
        dispose: async (pipe) => { if (pipe?.dispose) await pipe.dispose(); },
        aggregate: (scores) => {
            const nl = mean(scores.filter(s => s.language === 'nl').map(s => s.wer)), en = mean(scores.filter(s => s.language === 'en').map(s => s.wer));
            return { value: mean(scores.map(s => s.wer)), werNl: nl, werEn: en, label: `WER nl ${pct(nl)} · en ${pct(en)}`, detail: `Lower is better. Backend: ${useGpu() ? 'WebGPU fp16' : 'WASM fp32/q4'}. TTS audio is clean — real dictation will score worse.` };
        },
    }));
}

// ── Orchestration ────────────────────────────────────────────────────────────
const SECTIONS = { translate: translateSpecs, ner: nerSpecs, anonllm: anonLlmSpecs, summarize: summarizeSpecs, stt: sttSpecs };
let busy = false;
async function runSection(section, onlyId = null) {
    if (busy) return log('Busy — wait for the current run to finish.');
    busy = true;
    try {
        const specs = SECTIONS[section]();
        const sel = onlyId ? [cssId(onlyId)] : selectedIds(section);
        for (const spec of specs) if (sel.includes(cssId(spec.id))) await runModel(spec);
    } finally { busy = false; }
}
async function runAll() { for (const s of Object.keys(SECTIONS)) await runSection(s); log('All sections done.'); }

function exportJson() {
    const payload = { generated: new Date().toISOString(), env: envInfo(), results };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `medmorf-benchmark-${Date.now()}.json`; a.click();
}
function exportMd() {
    const b = detectBrowser();
    const lines = [`### Medmorf benchmark — ${b.name} ${b.version} on ${b.os}, ${new Date().toISOString().slice(0, 10)}`, '', '| Section | Model | Declared | Load | Inference/doc | Peak heap Δ | Quality | Status |', '|---|---|---:|---:|---:|---:|---|---|'];
    for (const r of results) lines.push(`| ${r.section} | ${r.model} | ${fmtMB(r.sizeMB)} | ${fmtMs(r.loadMs)} | ${fmtMs(r.inferMsPerDoc)} | ${r.heapSupported ? '+' + fmtMB(r.heapPeakDeltaMB) : 'n/a'} | ${r.quality?.label || '—'} | ${r.status}${r.error ? ' — ' + r.error : ''}${r.reason ? ' — ' + r.reason : ''} |`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => log('Markdown table copied to clipboard.'));
}
function envInfo() {
    const b = detectBrowser(), rt = getRuntimeMemorySnapshot();
    return { browser: `${b.name} ${b.version}`, os: b.os, deviceMemoryGB: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency, webgpu: snap?.webgpu, jsHeapLimitMB: rt.jsHeapLimitMB, safeCeilingMB: safeModelCeilingMB(snap), heapMeasured: rt.jsHeapSupported };
}

const MARKUP = `
<div class="bm-panel">
    <div class="bm-head"><h3>Model benchmark</h3>
    <p class="bm-sub">Loads every model option per tab (plus Qwen3.5 candidates) on synthetic fixtures (fictional patients) and records load time, inference time, peak JS heap and a task quality score. Models run <b>sequentially</b> and are disposed between runs. Unload models in the other tabs first for clean numbers. Chrome/Edge give heap numbers and WebGPU; Safari/Firefox show n/a for heap.</p></div>
    <div id="bmEnv" class="bm-kv"><span class="k">Probing…</span><span></span></div>
    <div class="bm-row">
        <label class="bm-inline"><input type="checkbox" id="bmSkipBig" checked> Skip models above the device's safe ceiling</label>
        <label class="bm-inline"><input type="checkbox" id="bmSttGpu"> Whisper on WebGPU (fp16) instead of WASM</label>
        <label class="bm-inline">Max docs per model <input type="number" id="bmNumDocs" value="4" min="1" max="10"></label>
        <button class="btn btn-primary btn-small" id="bmRunAll">Run everything</button>
        <button class="btn btn-ghost btn-small" id="bmExportJson">Export JSON</button>
        <button class="btn btn-ghost btn-small" id="bmExportMd">Copy Markdown table</button>
    </div>
</div>
<div class="bm-panel bm-legend"><h4>How to read the quality column</h4><ul class="bm-sub">
<li><b>WER</b> (speech) — word error rate, lower is better. 0% perfect; 10% ≈ one word in ten wrong.</li>
<li><b>chrF</b> (translation) — character-level overlap with a reference translation, higher is better; ≥60% is good for a 600M model, professional MT scores 70–80%.</li>
<li><b>Recall / precision</b> (anonymize) — recall = share of real identifiers found (a miss is a leak, this is the number that matters); precision = share of flagged items that were really identifiers.</li>
<li><b>Facts / halluc.</b> (summarize) — share of checklist facts present in the summary; share of hallucination probes (things not in the source) that appeared.</li>
</ul><p class="bm-sub">All models here are sized to run inside a browser tab. Larger self-hosted or cloud models score better on every task — the trade-off Medmorf makes is that data never leaves the device.</p></div>
<div class="bm-panel"><h4>Translate <span class="bm-tag">Transformers.js v2 · WASM</span> <button class="btn btn-ghost btn-small" data-run="translate">Run section</button></h4><div class="bm-wrap"><table class="bm-table" id="tbl-translate"></table></div></div>
<div class="bm-panel"><h4>Anonymize — NER detectors <span class="bm-tag">Transformers.js v4 / GLiNER</span> <button class="btn btn-ghost btn-small" data-run="ner">Run section</button></h4><div class="bm-wrap"><table class="bm-table" id="tbl-ner"></table></div></div>
<div class="bm-panel"><h4>Anonymize — LLM extraction <span class="bm-tag gpu">WebLLM · WebGPU</span> <button class="btn btn-ghost btn-small" data-run="anonllm">Run section</button></h4><div class="bm-wrap"><table class="bm-table" id="tbl-anonllm"></table></div></div>
<div class="bm-panel"><h4>Summarize <span class="bm-tag gpu">WebLLM · WebGPU</span> <button class="btn btn-ghost btn-small" data-run="summarize">Run section</button></h4><div class="bm-wrap"><table class="bm-table" id="tbl-summarize"></table></div></div>
<div class="bm-panel"><h4>Speech <span class="bm-tag">Transformers.js v4 · Whisper</span> <button class="btn btn-ghost btn-small" data-run="stt">Run section</button></h4><div class="bm-wrap"><table class="bm-table" id="tbl-stt"></table></div>
<p class="bm-sub" style="margin-top:0.6rem"><b>Reading the scores.</b> WER = words wrong ÷ words spoken (lower is better; 10% ≈ one word in ten). Reference points that do <em>not</em> fit in a browser (Whisper paper, FLEURS): medium — Dutch 10% / English 4%; large-v2 — Dutch 7% / English 4%; frontier cloud dictation services ≈ 4–6%. In-browser small: Dutch 16% / English 6% on the same benchmark. Clips here are synthetic TTS, so absolute numbers differ from FLEURS; compare models against each other, not against the reference.</p></div>
<div class="bm-panel"><h4>DICOM · Merge PDF · Storage</h4><p class="bm-sub">No ML models — nothing to benchmark. (OCR via Tesseract is only used inside PDF burn-in and is not model-selectable.)</p></div>
<div class="bm-panel"><h4>Log</h4><div id="bmLog" class="bm-log"></div><details><summary>Last model output</summary><textarea class="bm-out" id="bmLastOut" readonly></textarea></details></div>
`;

let mounted = false;
/** Mount the benchmark UI into `container` (idempotent). Fixtures and probes load lazily here, not at import. */
export async function mountBenchmark(container) {
    if (mounted) return;
    mounted = true;
    root = container;
    container.innerHTML = MARKUP;
    await init();
}
export function getBenchmarkResults() { return results; }

async function init() {
    snap = await getCapabilities();
    for (const k of ['anonymize', 'translate', 'summarize', 'speech']) fixtures[k] = await (await fetch(new URL(`../tests/fixtures/${k}.json`, import.meta.url))).json();
    const e = envInfo();
    $('#bmEnv').innerHTML = Object.entries({
        'Browser': `${e.browser} · ${e.os}`,
        'Reported RAM': e.deviceMemoryGB ? e.deviceMemoryGB + ' GB (bucket)' : 'not exposed',
        'JS heap limit': e.jsHeapLimitMB ? fmtMB(e.jsHeapLimitMB) : 'not exposed — heap columns will read n/a',
        'WebGPU': e.webgpu?.supported ? `yes · ${e.webgpu.adapterInfo?.vendor || ''} · max buffer ${fmtMB(e.webgpu.maxBufferSizeMB)}` : 'no — WebLLM sections will fail',
        'Safe model ceiling': fmtMB(e.safeCeilingMB),
        'Fixtures': `${fixtures.anonymize.documents.length} PII docs · ${fixtures.translate.pairs.length} sentence pairs · ${fixtures.summarize.documents.length} notes · ${fixtures.speech.clips.length} audio clips`,
    }).map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('');
    for (const [s, fn] of Object.entries(SECTIONS)) buildTable(s, fn());
    root.addEventListener('click', (ev) => {
        const one = ev.target.closest('[data-one]'); if (one) { const [s, id] = one.dataset.one.split('|'); runSection(s, id); }
        const sec = ev.target.closest('[data-run]'); if (sec) runSection(sec.dataset.run);
        if (ev.target.closest('.btn-ghost.small')) ev.preventDefault();
    });
    $('#bmRunAll').onclick = runAll;
    $('#bmExportJson').onclick = exportJson;
    $('#bmExportMd').onclick = exportMd;
    log('Ready.', e);
}
