# Medmorf - Medical Data Transformation

<p align="left">
  <img src="assets/brand/logo-horizontal.svg" alt="Medmorf" height="56">
</p>

Medmorf is a static, client-side PWA for transforming medical data in the browser. It can translate text and documents, anonymize PII, redact PDFs, summarize clinical documents, transcribe speech, index/sort DICOM folders, merge PDFs, and manage offline model caches.

User content is processed locally in the browser. The app has no backend, no analytics, no cookies, and no server-side processing. Network access is used to download public app dependencies, fonts, OCR data, and model weights from CDNs/model hosts; the files and text you process are not uploaded.

## Live Site

Hosted build:

https://putssander.github.io/medmorf/

After the first visit and model download, the service worker and browser caches allow the app shell and cached models to work offline.

## What Medmorf Does

| Area | Current capability |
| --- | --- |
| Translate | Text translation plus `.xlsx` and `.docx` upload workflows using NLLB-200. Excel translation preserves sheets/columns and writes translated columns to a new workbook. |
| Anonymize | PII detection and replacement for pasted text or `.pdf`, `.xlsx`, `.docx`, and `.txt` uploads. The Advanced settings use two model panels: NER / detector on the left and LLM on the right. When feasible, the default is OpenAI Privacy Filter + Qwen3 1.7B; constrained devices fall back to a CPU NER-only default. Hybrid validation is conservative: real PII is kept even when the detector type is imperfect. Detection chunks use overlap to preserve context across boundaries. PDF read failures are shown as plain user-facing messages with retry guidance. |
| PDF redaction | Integrated into Anonymize. Exports burn-in redaction PDFs by default, plus anonymized text (`.txt`) or PDF text rebuilds. Burn-in output rasterizes pages and removes original glyph/image text. Scanned pages can use OCR. |
| Summarize | WebGPU clinical summarization from pasted text or `.xlsx`, `.docx`, and `.txt` files. Templates include Dutch psychological report, SOAP note, and free-form summary. |
| Speech | Whisper transcription for microphone recordings or uploaded audio (`.mp3`, `.wav`, `.ogg`, `.webm`, `.m4a`, `.flac`, `.mp4`). Includes a dictaphone mode that can export `.xlsx` logs. |
| DICOM | Browser-based folder scanning, DICOM metadata indexing, modality filters, JSON/XLSX export, proposed sort previews, and generated PowerShell/robocopy scripts. Requires the File System Access API for folder workflows. |
| Merge PDF | Client-side PDF merge using `pdf-lib`. |
| Storage | Cache status, model preloading/clearing, app update refresh, and offline dependency checks. |

## Privacy and Healthcare Safety

- 100% client-side processing: no uploaded files, pasted text, audio, PDFs, or DICOM data are sent to a backend.
- No analytics, tracking scripts, cookies, telemetry, or account system.
- Runtime privacy guards clear sensitive state on tab close, refresh, navigation, and after 30 minutes of inactivity.
- Models and libraries are fetched from public CDNs/model hosts and then cached by the browser.
- You can inspect the runtime privacy report in DevTools with `window.medmorfSecurity.getPrivacyReport()`.

Read the supporting docs:

- [docs/PRIVACY.md](docs/PRIVACY.md)
- [docs/PRIVACY_VERIFICATION.md](docs/PRIVACY_VERIFICATION.md)
- [docs/HEALTHCARE_SAFETY.md](docs/HEALTHCARE_SAFETY.md)
- [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)

## Run Locally

Medmorf has no build step and no package manager requirement. Serve the repository root with any static HTTP server so the service worker, import map, module scripts, and relative assets share the same origin.

```bash
git clone https://github.com/putssander/medmorf.git
cd medmorf

python3 -m http.server 8000
```

Open:

- App: http://localhost:8000/
- README: http://localhost:8000/README.md
- Documentation folder: http://localhost:8000/docs/
- Brand guide HTML preview: http://localhost:8000/docs/brand/medmorf-brand-guide.html
- Diagnostic page: http://localhost:8000/tests/test-upgrade.html

Alternative static servers also work, for example:

```bash
npx http-server -p 8000
```

Do not rely on `file://` for normal local testing. Some simple UI paths may load from disk, but the PWA service worker, offline cache behavior, module loading, and app-update flow require `http://` or `https://`.

## Browser Notes

- On iPhone/iPad, Summarize offers only Qwen3 0.6B (~1.4 GB) — the largest model empirically known to run on a real iPhone; Qwen3.5 0.8B (~1.63 GB) and up crashed an iPhone 17 Pro during load and are disabled there. Anonymize's LLM pipeline (2B minimum) stays blocked on iOS and falls back to NER-only; Speech and Translate work on iOS.

- Chrome and Edge are the best-supported browsers for WebGPU model workflows.
- Safari 18+ can support WebGPU on compatible devices, but browser memory reporting is more limited.
- Firefox can run many WASM paths, but WebGPU-dependent LLM features may not be available.
- DICOM folder scanning/sorting depends on the File System Access API, which is strongest in Chromium browsers.
- Large models need significant memory. The app shows pre-flight warnings and runtime resource estimates before heavy model loads.
- A live memory bar sits at the top of every page (`src/memory-monitor.js`). It combines the live JS heap (Chromium only) with the weights of currently loaded models and compares them to a conservative per-tab guardrail. Click it for your detected environment (browser, RAM bucket, heap limit, WebGPU) and per-browser guidance. Safari and Firefox do not expose live memory, so the bar is an estimate there (shown with ≈).

Each model tab has a **▶ Try example** button (`src/try-example.js`) that feeds the bundled synthetic sample straight into the normal upload pipeline — no download-and-reupload needed.

## Supported Inputs and Outputs

| Workflow | Inputs | Outputs |
| --- | --- | --- |
| Translate | Text, `.xlsx`, `.docx` | Translated text or translated `.xlsx` |
| Anonymize | Text, `.pdf`, `.xlsx`, `.docx`, `.txt` | Anonymized text, `.txt`, `.xlsx`, PDF text rebuild, PDF burn-in redaction, mapping `.xlsx`/`.json` |
| Summarize | Text, `.xlsx`, `.docx`, `.txt` | Downloadable text report |
| Speech | Microphone, `.mp3`, `.wav`, `.ogg`, `.webm`, `.m4a`, `.flac`, `.mp4` | Transcript text; dictaphone log `.xlsx` |
| DICOM | Local DICOM folders/files (`.dcm`, `.dicom`, `.dic`) | Index `.json`, index `.xlsx`, PowerShell/robocopy script, sorted folder copy |
| Merge PDF | Multiple PDFs | Merged PDF |

## Runtime Architecture

Medmorf is intentionally a static vanilla-JS app:

- No bundler, no backend, no server folder, and no runtime package install.
- `index.html`, `manifest.webmanifest`, and `sw.js` stay at the repo root for PWA scope.
- Client-side JavaScript lives in a flat `src/` directory and uses sibling-relative module imports.
- CSS is split between `styles/styles.css` for older component styles and `styles/brand.css` for brand tokens/overrides.
- `sw.js` uses `CACHE_NAME = 'medmorf-app-v54'` for the app shell and CDN dependency cache. Model weights are kept separately by WebLLM, Transformers.js, IndexedDB, and the Cache API.

Main browser dependencies:

| Dependency | Version/source | Used for |
| --- | --- | --- |
| Tailwind Play CDN | `https://cdn.tailwindcss.com?plugins=forms,typography` | Utility CSS and theme tokens |
| SheetJS | `xlsx@0.18.5` | Excel read/write |
| FileSaver.js | `2.0.5` | Browser downloads |
| Mammoth.js | `1.6.0` | Word text extraction |
| pdf-lib | `1.17.1` | PDF merge and rebuilt PDFs |
| pdf.js | `pdfjs-dist@4.7.76` | PDF text extraction/rendering |
| Tesseract.js | `5.1.1` | OCR for scanned PDF redaction |
| WebLLM | `@mlc-ai/web-llm@0.2.83` | In-browser Qwen3 LLM inference |
| Transformers.js v2 | `@xenova/transformers@2.17.2` | NLLB translation runtime |
| Transformers.js v4 | `@huggingface/transformers@4.2.0` | NER, privacy filter, and Whisper pipelines |
| GLiNER.js | `gliner@0.0.19` via `esm.sh` | GLiNER PII model wrapper |
| ONNX Runtime Web | `1.26.0-dev.20260416-b7804b056c` | WASM/WebGPU model execution |
| Hugging Face Jinja | `@huggingface/jinja@0.5.6` | Transformer chat/template support |

## Models

| Workflow | Model(s) |
| --- | --- |
| Translation | `Xenova/nllb-200-distilled-600M`, quantized, loaded through Transformers.js v2 |
| Anonymize LLM | `Qwen3.5-2B-q4f16_1-MLC` (default), `Qwen3.5-4B-q4f16_1-MLC`. Qwen3 was dropped after benchmarking (same memory class, far lower PII recall); 0.8B is excluded here because it returns an empty list with the extraction prompt. All ≤4B by design — larger models exceed browser per-tab memory. |
| NER | `openai/privacy-filter` preferred default when feasible, `onnx-community/multilang-pii-ner-ONNX` CPU fallback, `knowledgator/gliner-pii-edge-v1.0`, `Xenova/bert-base-multilingual-cased-ner-hrl` |
| Summarize | `Qwen3-0.6B-q4f16_1-MLC` (iPhone-only tier), `Qwen3.5-0.8B-q4f16_1-MLC`, `Qwen3.5-2B-q4f16_1-MLC` (default), `Qwen3.5-4B-q4f16_1-MLC` |
| Speech | `onnx-community/whisper-tiny`, `onnx-community/whisper-base`, `onnx-community/whisper-small`. Whisper small is the default on every device — benchmark (iOS Simulator, WASM): tiny Dutch WER 64%, base 42%, small 23%. The browser's built-in dictation (Web Speech API) is deliberately not used: it gives no on-device guarantee. |

Recordings are **crash-safe**: PCM is persisted to IndexedDB every ~5 s while recording, transcription runs in 2-minute checkpointed segments, and after a browser kill (e.g. iOS memory pressure) the Speech tab offers the saved audio for download, resume-from-last-segment, or discard (`src/stt-store.js`; wiped on success, on discard, and by Storage → Delete all). Speech-to-text is strictly two-phase: record (raw 16 kHz PCM captured from the microphone graph; MediaRecorder only produces the downloadable file) → transcribe (one Whisper inference, starts automatically on Stop, with per-chunk progress/ETA and a timeout scaled to clip length). Live as-you-speak transcription was removed because in-browser Whisper is slower than real time on phones. Long recordings are supported; `tests/fixtures/speech-long/nl_conversation_15min.mp3` (15.3 min synthetic Dutch conversation) is the regression fixture — see "Long recordings" below.

The translation runtime deliberately uses Transformers.js v2 because the NLLB 600M model is more memory efficient there. NER/STT use the newer Hugging Face Transformers.js runtime through the import map. GLiNER imports are patched through the import map so `gliner@0.0.19` uses the compatible tokenizer/runtime path for the ModernBERT PII model.

STT defaults to WASM for stability. Power users can opt into WebGPU speech inference with:

```text
http://localhost:8000/?stt-gpu=1
```

## Translation Languages

The UI currently exposes these NLLB language options for text and document translation:

Dutch, English, German, French, Spanish, Portuguese, Italian, Polish, Romanian, Czech, Danish, Swedish, Norwegian, Finnish, Greek, Hungarian, Bulgarian, Croatian, Slovak, Slovenian, Estonian, Latvian, Lithuanian, Irish, Maltese, Russian, Ukrainian, Turkish, Arabic, Chinese Simplified, Chinese Traditional, Japanese, Korean, Hindi, Indonesian, Thai, and Vietnamese.

## File Structure

```text
medmorf/
|-- index.html
|-- manifest.webmanifest
|-- _headers
|-- sw.js
|-- tools/
|   |-- deploy-pages.sh
|   `-- dev-server-isolated.mjs
|-- README.md
|-- AGENTS.md
|-- .gitignore
|-- .github/
|   |-- copilot-instructions.md
|   `-- workflows/
|       `-- deploy.yml
|-- assets/
|   `-- brand/
|       |-- apple-touch-icon.svg
|       |-- favicon-light.svg
|       |-- favicon.svg
|       |-- icon-192.svg
|       |-- icon-512.svg
|       |-- icon-mark.svg
|       |-- logo-horizontal-dark.svg
|       |-- logo-horizontal.svg
|       `-- safari-pinned-tab.svg
|-- docs/
|   |-- DEPLOYMENT.md
|   |-- HEALTHCARE_SAFETY.md
|   |-- PRIVACY.md
|   |-- PRIVACY_VERIFICATION.md
|   |-- SECURITY_AUDIT.md
|   `-- brand/
|       |-- medmorf-brand-guide.html
|       `-- medmorf-brand-guide.md
|-- src/
|   |-- anonymize-handler.js
|   |-- anonymize-prompts.js
|   |-- benchmark-handler.js
|   |-- app.js
|   |-- cache-manager.js
|   |-- device-capabilities.js
|   |-- dicom-handler.js
|   |-- excel-handler.js
|   |-- lifecycle-manager.js
|   |-- memory-monitor.js
|   |-- pdf-anonymize-handler.js
|   |-- pdf-handler.js
|   |-- pre-flight-warn.js
|   |-- privacy-runtime.js
|   |-- security.js
|   |-- stt-handler.js
|   |-- stt-store.js
|   |-- summarize-handler.js
|   |-- translation-runtime.js
|   |-- try-example.js
|   |-- word-handler.js
|   `-- stubs/
|       |-- empty-module.js
|       `-- null-module.js
|-- styles/
|   |-- brand.css
|   `-- styles.css
`-- tests/
    |-- test-models.html
    |-- metrics.js
    |-- fixtures/
    |   |-- anonymize.json
    |   |-- summarize.json
    |   |-- translate.json
    |   |-- speech.json
    |   `-- speech/ (4 synthetic 16 kHz WAV clips, NL + EN)
    |-- test-upgrade.html
    |-- test_anonymisation_file.txt
    |-- test_mapping.xlsx
    |-- test_summary_psychological_interview.txt
    `-- test_translation_file.xlsx
```

## Brand

The brand guide lives at [docs/brand/medmorf-brand-guide.md](docs/brand/medmorf-brand-guide.md), with an HTML preview at [docs/brand/medmorf-brand-guide.html](docs/brand/medmorf-brand-guide.html). App icons and logos live in `assets/brand/` and are referenced by `index.html`, `manifest.webmanifest`, and the service worker app shell.

The app interface uses a narrow, iOS-inspired grouped layout with restrained surfaces, touch-sized controls, and horizontally scrollable tool navigation on small screens. Accuracy, hardware, and operational guidance remains available in expandable disclosures so the primary workflow stays concise without weakening privacy or healthcare-safety information.

## Accuracy and WER

Speech-to-text accuracy is reported as **WER (word error rate)**: words wrong ÷ words spoken, lower is better; 10% means about one word in ten needs correcting. Because Medmorf runs entirely in the browser, the largest usable Whisper is *small*. The Speech tab has an expandable "Accuracy: what to expect" panel with this table; the same numbers guide the model descriptions:

| Model | Runs | Dutch WER | English WER |
| --- | --- | --- | --- |
| Whisper tiny | in browser | 49% | 12% |
| Whisper base | in browser | 33% | 9% |
| **Whisper small (default)** | in browser | **16%** | **6%** |
| Whisper medium | server GPU only | 10% | 4% |
| Whisper large-v2/v3 | server GPU only | 7% | 4% |
| Frontier cloud dictation (2026) | vendor cloud | ≈4–6% avg. | |

Whisper rows: OpenAI Whisper paper, FLEURS (clean read speech); real dictation scores worse for every model. Frontier row: public 2026 vendor benchmarks (Microsoft MAI-Transcribe-1 3.8% avg on FLEURS, AssemblyAI Universal-3 5.6%, NVIDIA Parakeet-TDT 6.3%). Users must proofread numbers, dosages and names regardless of model.

The same "in-browser vs larger/frontier" explainer exists on every model tab (expandable "Accuracy: what to expect" panel):

| Task | Metric | In-browser (Medmorf) | Larger / frontier (not in-browser) |
| --- | --- | --- | --- |
| Anonymize | recall (share of identifiers found; a miss is a leak) | NER ≈ 75–85%, Qwen3.5 2B ≈ 83%, NER + LLM highest | GPT-4-class ≈ 90–95%; specialised clinical de-id 96–99% on i2b2 |
| Summarize | fact coverage / hallucination probes | ≈ 85% coverage, 0 hallucinations on synthetic notes | adapted GPT-4 judged ≥ physician quality in 81% of cases (Nature Medicine 2024) |
| Translate | chrF (character overlap with reference) | NLLB-200 600M ≈ 72% on short clinical sentences | NLLB 1.3B/3.3B/54B, DeepL, GPT-4-class: higher fluency and terminology |
| Speech | WER | Whisper small: Dutch 16%, English 6% (FLEURS) | Whisper large-v2 7% / 4%; frontier cloud ≈ 4–6% |

Every panel ends with the same instruction: the output is a first pass that must be checked by a human, in exchange for data never leaving the device.

## Long recordings

Measured 2026-08-30 with `tests/fixtures/speech-long/nl_conversation_15min.mp3` (15.3 min, Whisper small, WASM):

| Environment | Result |
| --- | --- |
| iOS Simulator (iPhone 17, iOS 26.5), ORT proxy worker | Completed all 103 chunks; page stayed responsive throughout (progress/ETA updating, memory bar ≈ 500 MB of the 1.5 GB cap). Wall time ≈ 28 min while a desktop run competed for CPU — expect **slower than real time on phones**, and more so on older devices. |
| Chrome 151 desktop (M-series, WASM + proxy worker, **single-threaded** because the site is not cross-origin isolated) | No reload or crash; peak JS heap 705 MB; after 20 min still finishing the last of 47 chunks (~0.75× real time). Enabling cross-origin isolation (COOP/COEP headers → multithreaded WASM) is the identified lever for real-time speed; see "Cross-origin isolation" below. |

Guidance built into the Speech tab: for long sessions on a phone use **Dictaphone** mode (each entry is transcribed while you talk the next one, so nothing waits at the end); for a single long recording keep the tab in the foreground until it finishes. Before the ORT proxy worker was enabled, the same transcription froze the page on iOS — that was the "hang".

## Cross-origin isolation (multithreaded WASM)

**Hosting:** deployed to Cloudflare Pages (`https://medmorf.pages.dev`, project `medmorf`) with the isolation headers from `_headers` active — the page is cross-origin isolated in production. Redeploy with `tools/deploy-pages.sh` (clean `git archive` of HEAD), or connect the repo in the Cloudflare dashboard for deploy-on-push. The repo ships a `_headers` file with the isolation headers. GitHub Pages ignores it (the current medmorf.com host — runs single-threaded). Cloudflare Pages picks it up automatically; migration steps: create a Pages project → connect this repo (no build command, output directory `/`) → add the custom domain → move medmorf.com's nameservers to Cloudflare. After deploy, verify in the console that `crossOriginIsolated === true` and that CDN assets (jsDelivr, HF, cdnjs, Tailwind) still load. Browsers without `COEP: credentialless` support ignore the header and stay single-threaded — never broken.

Without `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers a page gets no `SharedArrayBuffer`, so ONNX Runtime WASM runs **single-threaded** — the main reason Whisper small ran slower than real time. Measured on the same machine, same 100 s Dutch clip, Whisper small on WASM:

| Serving | Threads | Time |
| --- | --- | --- |
| Plain static server | 1 | 15-min clip: > 20 min (~0.75× real time) |
| With COOP + `COEP: credentialless` | multi | 100 s clip: **89 s (~1.1× real time)** |

`COEP: credentialless` is the header to use — `require-corp` blocks the Tailwind CDN and the Inter font (no CORP headers), `credentialless` keeps everything loading and still isolates. For local testing: `node tools/dev-server-isolated.mjs` (port 8001). For production hosting add both headers (e.g. Cloudflare Pages `_headers`):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

Note: Safari's support for `credentialless` should be verified on target iOS versions before shipping the headers; with `require-corp` the Tailwind/Inter tags would need `crossorigin` attributes and CORS-enabled hosts instead.

## Model Benchmark

The **Benchmark** tab in the app (also standalone at `http://localhost:8000/tests/test-models.html`; logic in `src/benchmark-handler.js`) loads every model option per tab — NLLB translation, the four NER detectors, Whisper tiny/base/small, and the WebLLM LLMs for Anonymize and Summarize (the app's Qwen3.5 0.8B/2B/4B plus Qwen3 0.6B/1.7B/4B as reference baselines, all from the pinned WebLLM 0.2.83; anything larger — Qwen3 8B, Qwen3.5 9B, Qwen3.6/3.8 at 27B+ — is excluded as not browser-viable) — and runs each on synthetic fixtures in `tests/fixtures/` (fictional patients, no real data). For every model it records load time, inference time per document, peak JS heap delta (Chromium only) and a task quality score computed by `tests/metrics.js`:

- Anonymize (NER and LLM): PII **recall** per type (a miss is a leak), precision against annotated spans; the LLM uses the exact prompt from `src/anonymize-prompts.js`.
- Translate: **chrF** against reference English.
- Summarize: **fact coverage** from a checklist plus hallucination probes.
- Speech: **WER** for Dutch and English clips (macOS TTS audio; real dictation scores worse).

Models are run sequentially and disposed between runs; models above the device's safe ceiling are skipped unless overridden. Results can be exported as JSON or copied as a Markdown table. Run it in Chrome/Edge for heap numbers and WebGPU; Safari/Firefox show `n/a` for heap.

## Troubleshooting

- If a model download fails, check the network connection and anything blocking `huggingface.co`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `esm.sh`, Google Fonts, or `tessdata.projectnaptha.com`.
- If Chrome reports a `Cache.add()` failure while loading Qwen, clear the LLM/WebLLM cache from the Storage tab, hard refresh, keep the tab in the foreground, and retry.
- If a model crashes or hangs, choose a smaller model, use NER-only mode, close memory-heavy tabs, and keep Medmorf visible during long runs.
- If DICOM folder buttons are unavailable, use a Chromium browser with File System Access API support.
- If offline mode does not behave as expected locally, make sure the app is served over `http://localhost:8000/` rather than opened with `file://`.

## Contributing

Before changing code, read [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md). Any change that affects features, files, dependencies, privacy posture, local serving, service-worker cache versioning, or folder structure must update this README in the same change.
