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
| Anonymize | PII detection and replacement for pasted text or `.pdf`, `.xlsx`, `.docx`, and `.txt` uploads. The Advanced settings use two model panels: NER / detector on the left and LLM on the right. When feasible, the default is OpenAI Privacy Filter + Qwen3 1.7B; constrained devices fall back to a CPU NER-only default. Hybrid validation is conservative: real PII is kept even when the detector type is imperfect. |
| PDF redaction | Integrated into Anonymize. Exports PDF text rebuilds or burn-in redaction PDFs that rasterize pages and remove original glyph/image text. Scanned pages can use OCR. |
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

- Chrome and Edge are the best-supported browsers for WebGPU model workflows.
- Safari 18+ can support WebGPU on compatible devices, but browser memory reporting is more limited.
- Firefox can run many WASM paths, but WebGPU-dependent LLM features may not be available.
- DICOM folder scanning/sorting depends on the File System Access API, which is strongest in Chromium browsers.
- Large models need significant memory. The app shows pre-flight warnings and runtime resource estimates before heavy model loads.

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
- `sw.js` uses `CACHE_NAME = 'medmorf-app-v25'` for the app shell and CDN dependency cache. Model weights are kept separately by WebLLM, Transformers.js, IndexedDB, and the Cache API.

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
| Anonymize LLM | `Qwen3-0.6B-q4f16_1-MLC`, `Qwen3-1.7B-q4f16_1-MLC` preferred default when feasible, `Qwen3-4B-q4f16_1-MLC`, `Qwen3-8B-q4f16_1-MLC` |
| NER | `openai/privacy-filter` preferred default when feasible, `onnx-community/multilang-pii-ner-ONNX` CPU fallback, `knowledgator/gliner-pii-edge-v1.0`, `Xenova/bert-base-multilingual-cased-ner-hrl` |
| Summarize | Same Qwen3 WebLLM model set as Anonymize |
| Speech | `onnx-community/whisper-tiny`, `onnx-community/whisper-base`, `onnx-community/whisper-small` |

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
|-- sw.js
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
|   |-- app.js
|   |-- cache-manager.js
|   |-- device-capabilities.js
|   |-- dicom-handler.js
|   |-- excel-handler.js
|   |-- lifecycle-manager.js
|   |-- pdf-anonymize-handler.js
|   |-- pdf-handler.js
|   |-- pre-flight-warn.js
|   |-- privacy-runtime.js
|   |-- security.js
|   |-- stt-handler.js
|   |-- summarize-handler.js
|   |-- translation-runtime.js
|   |-- word-handler.js
|   `-- stubs/
|       |-- empty-module.js
|       `-- null-module.js
|-- styles/
|   |-- brand.css
|   `-- styles.css
`-- tests/
    |-- test-upgrade.html
    |-- test_anonymisation_file.txt
    |-- test_mapping.xlsx
    |-- test_summary_psychological_interview.txt
    `-- test_translation_file.xlsx
```

## Brand

The brand guide lives at [docs/brand/medmorf-brand-guide.md](docs/brand/medmorf-brand-guide.md), with an HTML preview at [docs/brand/medmorf-brand-guide.html](docs/brand/medmorf-brand-guide.html). App icons and logos live in `assets/brand/` and are referenced by `index.html`, `manifest.webmanifest`, and the service worker app shell.

## Troubleshooting

- If a model download fails, check the network connection and anything blocking `huggingface.co`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `esm.sh`, Google Fonts, or `tessdata.projectnaptha.com`.
- If Chrome reports a `Cache.add()` failure while loading Qwen, clear the LLM/WebLLM cache from the Storage tab, hard refresh, keep the tab in the foreground, and retry.
- If a model crashes or hangs, choose a smaller model, use NER-only mode, close memory-heavy tabs, and keep Medmorf visible during long runs.
- If DICOM folder buttons are unavailable, use a Chromium browser with File System Access API support.
- If offline mode does not behave as expected locally, make sure the app is served over `http://localhost:8000/` rather than opened with `file://`.

## Contributing

Before changing code, read [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md). Any change that affects features, files, dependencies, privacy posture, local serving, service-worker cache versioning, or folder structure must update this README in the same change.
