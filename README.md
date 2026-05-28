# Medmorf — Medical Data Transformation

<p align="left">
  <img src="assets/brand/logo-horizontal.svg" alt="Medmorf" height="56">
</p>

**Medmorf transforms medical data into safer, structured, and usable formats — entirely in your browser.**
It supports speech-to-text, multilingual translation, de-identification (PII redaction), document merging, DICOM tag editing, PDF/Word/Excel processing, and clinical summarization. No data ever leaves your device.

## 🚀 Live Site

**👉 [https://putssander.github.io/medmorf/](https://putssander.github.io/medmorf/)**

Nothing to install — open the link in Chrome, Edge, Firefox, or Safari and start. After the first visit, models are cached locally and the app works fully offline (PWA).

## ✨ What Medmorf does

| Pillar | Capability |
|---|---|
| 🎙 **Transcribe** | Speech-to-text for clinical audio (Whisper / Transformers.js on WASM by default; WebGPU opt-in via `?stt-gpu=1`). Record → stop → click **Transcribe**, or upload an audio file. Live/streaming transcription has been removed for stability. |
| 🌐 **Translate** | Multilingual medical translation (NLLB-200) — Dutch, English, German, French, Spanish, Italian, Portuguese, +200 languages |
| 🛡 **Protect** | De-identify PII via XLM-RoBERTa, GLiNER (ModernBERT), mBERT, optionally verified by an in-browser LLM (Qwen3 0.6B/1.7B/4B/8B via WebLLM + WebGPU). Accepts file uploads (`.pdf`, `.xlsx`, `.docx`, `.txt`) **or** direct paste via the “Or paste text directly” panel. Includes smart bundling for person aliases (e.g. `S. Puts` ↔ `Puts`) and auto-renumbering so replacement tags stay contiguous. |
| 📚 **Summarize** | Clinical-summary generation with the same WebLLM stack (Qwen3 4B by default) |
| 🩻 **DICOM** | In-browser DICOM tag editing, anonymization presets, modality-aware sorting |
| 📄 **Documents** | `.xlsx` (sheet/column-aware), `.docx`, and `.pdf` ingestion + export |
| 🔳 **PDF redaction** | Burn-in redaction is integrated into the Anonymize tab — detection runs with the user-selected NER/LLM pipeline, then choosing the **PDF (burn-in)** download format produces a re-rasterized PDF with the original glyph/image text physically removed (auto-OCR on scanned pages) |
| 💾 **Offline-first** | Full PWA — service worker caches the app shell + CDN deps; model weights persist in IndexedDB / Cache API |
| 🔄 **App updates** | Storage tab → *App Updates* lets you refresh code without redownloading model weights |

## 🔒 Privacy & healthcare safety

- **100% in-browser** — zero data transmission, zero analytics, zero cookies, no server-side processing.
- **Auto-clear** on tab close, refresh, navigation, or 30 minutes of inactivity.
- **GDPR-compliant by design**; suitable for HIPAA-aligned workflows.
- Verify yourself in DevTools: `window.medmorfSecurity.getPrivacyReport()`.

See [docs/PRIVACY.md](docs/PRIVACY.md), [docs/PRIVACY_VERIFICATION.md](docs/PRIVACY_VERIFICATION.md), [docs/HEALTHCARE_SAFETY.md](docs/HEALTHCARE_SAFETY.md), and [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## 🚀 Quick Start

### Use the hosted site (recommended)

Open **[https://putssander.github.io/medmorf/](https://putssander.github.io/medmorf/)** — nothing else required.

### Run locally

```bash
git clone https://github.com/putssander/medmorf.git
cd medmorf

# Serve from the repo root (service worker requires same origin)
python3 -m http.server 8000
# or
npx http-server -p 8000
```

Then open `http://localhost:8000`. Opening `index.html` via `file://` works for most features, but the service worker (offline mode + app-update flow) requires an `http(s)://` origin.

## 🏥 Healthcare Data Privacy

### Verified Safe for Medical Data

Medmorf is specifically designed for processing sensitive healthcare data:

- **No Server Processing**: All translation happens in YOUR browser using WebAssembly
- **No Data Transmission**: Your files never leave your device
- **No Cloud Services**: We don't have servers - nothing to hack or breach
- **Automatic Memory Clearing**: Data automatically cleared when you close the tab, refresh, or navigate away
- **Inactivity Protection**: Data cleared after 30 minutes of inactivity
- **Audit Trail**: Open source code anyone can verify
- **Privacy Verification**: Run `window.medmorfSecurity.getPrivacyReport()` in console to verify

### For Healthcare Professionals

✅ **Recommended**:
- Use on encrypted, password-protected devices
- Use private/incognito browser mode
- Close tab when finished (data clears automatically)
- Verify HTTPS connection (🔒 in address bar)
- No manual clearing needed - fully automated

❌ **Not Recommended**:
- Public or shared computers
- Unencrypted devices
- Outdated browsers

See [docs/PRIVACY.md](docs/PRIVACY.md) for complete privacy documentation.

---

## 📖 How to Use

### Translating Excel Files

1. **Upload**: Click the upload area or drag & drop your `.xlsx` file
2. **Select Sheet**: Choose which sheet contains the data you want to translate
3. **Select Columns**: Check the columns you want to translate
4. **Choose Languages**: Select source and target languages
5. **Translate**: Click "Start Translation"
6. **Download**: Once complete, download the translated file

**Note**: Translated columns will be added as new columns in the output file, preserving your original data.

### Translating Word Documents

1. **Upload**: Click the upload area or drag & drop your `.docx` file
2. **Choose Languages**: Select source and target languages
3. **Translate**: Click "Start Translation"
4. **Download**: Once complete, download the translated text file

**Note**: Currently outputs as plain text. Formatting from the original document is not preserved.

## 🛠️ Technical Details

### Technologies Used

- **[Transformers.js v2](https://github.com/xenova/transformers.js)**: Translation pipeline (`@xenova/transformers@2.17.2`)
- **[Transformers.js v3](https://huggingface.co/docs/transformers.js)**: NER pipeline (`@huggingface/transformers@3.8.1`)
- **[GLiNER.js](https://github.com/nicholasgriffintn/gliner.js)**: Zero-shot NER via ONNX (`gliner@0.0.19`)
- **[WebLLM](https://webllm.mlc.ai/)**: In-browser LLM for PII verification (`@mlc-ai/web-llm`, Qwen3-4B, WebGPU)
- **[ONNX Runtime Web](https://onnxruntime.ai/)**: Model inference backend
- **[NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M)**: Facebook's multilingual translation model (distilled version)
- **[GLiNER PII Edge](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0)**: ModernBERT-based PII detection model (32M params)
- **[SheetJS](https://sheetjs.com/)**: Excel file reading and writing
- **[Mammoth.js](https://github.com/mwilliamson/mammoth.js)**: Word document text extraction
- **[FileSaver.js](https://github.com/eligrey/FileSaver.js/)**: File download functionality

### Supported Languages

The NLLB-200 model supports translation between 200+ languages. Currently configured languages:

- Dutch (Nederlands) - `nld_Latn`
- English - `eng_Latn`
- German (Deutsch) - `deu_Latn`
- French (Français) - `fra_Latn`
- Spanish (Español) - `spa_Latn`
- Italian (Italiano) - `ita_Latn`
- Portuguese (Português) - `por_Latn`

**Want more languages?** You can easily add more by editing the language dropdowns in `index.html`.

### Model Information

#### Translation
- **Model**: `Xenova/nllb-200-distilled-600M`
- **Size**: ~300MB (downloaded once and cached by your browser)
- **First Use**: The first time you use the tool, it will download the model. This may take a few minutes depending on your internet connection.
- **Subsequent Uses**: The model is cached, so translations start immediately

#### Anonymization / NER
- **GLiNER PII**: `knowledgator/gliner-pii-edge-v1.0` — ModernBERT, ~46MB, zero-shot PII detection
- **Multilang PII**: XLM-RoBERTa token-classification, multilingual (Dutch, English, French, German)
- **Multilingual NER**: mBERT, general-purpose named entity recognition
- **LLM (optional)**: Qwen3 4B via WebGPU — additional PII verification pass

## ⚡ Performance

- **Speed**: Varies by device and text length. Expect ~0.5-2 seconds per paragraph on modern hardware
- **Memory**: Requires ~2-3GB of available RAM for optimal performance
- **Browser**: Works best on Chrome/Edge (V8 engine optimization)

## 🔧 Customization

### Adding More Languages

Edit `index.html` and add options to the language selectors:

```html
<option value="language_code">Language Name</option>
```

Find language codes in the [NLLB documentation](https://github.com/facebookresearch/flores/blob/main/flores200/README.md#languages-in-flores-200).

### Changing the Translation Model

Edit `src/translation-runtime.js` and change the model name:

```javascript
translator = await pipeline('translation', 'Xenova/your-model-name');
```

### Adjusting Batch Size

For Excel files with many cells, you can adjust translation speed vs. memory usage by modifying the batch processing logic in `src/app.js`.

## 🐛 Troubleshooting

### Model Won't Download

- **Check Internet Connection**: Ensure you have a stable internet connection
- **Clear Browser Cache**: Try clearing your browser's cache and reload
- **Try Different Browser**: Some browsers may have stricter caching policies

### Translation is Slow

- **Close Other Tabs**: Free up memory by closing unused tabs
- **Reduce Batch Size**: Translate smaller sections at a time
- **Use Modern Browser**: Chrome and Edge typically offer best performance

### Processing Stops After Switching Tabs

- **Keep Medmorf visible**: Long anonymization, summarization, and transcription runs are safest with the tab in the foreground
- **Background tabs can be throttled**: Browsers may suspend timers, drop GPU work, or evict loaded models, especially on Safari and mobile devices

### File Won't Upload

- **Check File Size**: Very large files may cause issues. Try with smaller files first
- **Check File Format**: Ensure files are `.xlsx` or `.docx` format
- **Check File Corruption**: Try opening the file in Excel/Word first

### Translation Quality Issues

- **Source Language**: Ensure you've selected the correct source language
- **Model Limitations**: The distilled model is faster but may be less accurate than full models
- **Context**: Short phrases may translate less accurately than full sentences

## 🔐 Privacy & Security

- ✅ All processing happens in your browser
- ✅ No data is sent to any server
- ✅ No analytics or tracking
- ✅ Works offline after initial model download
- ✅ Open source - inspect the code yourself

## 📝 File Structure

```
medmorf/
├── index.html              # App shell + import map + Tailwind/brand config
├── sw.js                   # Service worker (must stay at root for full-site scope)
├── manifest.webmanifest    # PWA manifest (root-served)
├── README.md               # This file (root for GitHub rendering)
├── AGENTS.md               # Pointer to agent instructions
├── .github/
│   ├── copilot-instructions.md   # AI-agent rules (auto-loaded by Copilot)
│   └── workflows/deploy.yml      # GitHub Pages deploy
├── docs/
│   ├── DEPLOYMENT.md
│   ├── PRIVACY.md
│   ├── PRIVACY_VERIFICATION.md
│   ├── HEALTHCARE_SAFETY.md
│   ├── SECURITY_AUDIT.md
│   └── brand/              # Brand guide (Markdown + HTML preview)
├── assets/brand/           # Logo, favicons, app icons (SVG)
├── styles/
│   ├── styles.css          # Legacy component styles
│   └── brand.css           # Brand layer (tokens + JS-hooked classes)
├── src/                    # All client-side JS (flat — sibling imports)
│   ├── app.js                       # Translation tab UI
│   ├── security.js                  # Runtime privacy guards + auto-clear
│   ├── cache-manager.js             # Storage tab + offline downloads + app-update logic
│   ├── device-capabilities.js       # GPU/RAM probing + model risk classification
│   ├── pre-flight-warn.js           # Pre-load capability warning UI + heavy-load lock
│   ├── lifecycle-manager.js         # Loaded-model registry + idle eviction
│   ├── privacy-runtime.js           # NER pipeline (Transformers.js v3 + GLiNER patches)
│   ├── translation-runtime.js       # NLLB-200 (Transformers.js v2)
│   ├── anonymize-handler.js         # Anonymize tab UI + LLM verification
│   ├── summarize-handler.js         # Summarize tab UI + LLM
│   ├── stt-handler.js               # Speech-to-text tab
│   ├── dicom-handler.js             # DICOM tag editor + sort tab
│   ├── pdf-handler.js               # PDF merge tab
│   ├── pdf-anonymize-handler.js     # PDF burn-in library (text-layer + auto-OCR + black-box rasterization), used by anonymize-handler
│   ├── word-handler.js              # .docx ingestion
│   ├── excel-handler.js             # .xlsx sheet/column UI
│   └── stubs/{empty,null}-module.js # Browser shims for Node-only modules
└── tests/                  # Sample fixtures + diagnostic page
    ├── test-upgrade.html
    └── test_*.{txt,xlsx}
```

There is intentionally **no `server/` folder** — Medmorf is 100% client-side. All processing happens in the browser; nothing is sent to a backend.

## 🎨 Brand

The full brand system lives at [docs/brand/medmorf-brand-guide.md](docs/brand/medmorf-brand-guide.md). The icon set in `assets/brand/` (favicon, app icons 192/512, Apple touch icon, Safari pinned tab, horizontal logo light/dark) is referenced by `index.html` and registered in `manifest.webmanifest`. Brand tokens (colors, gradient, fonts, radii, shadows) are exposed both as CSS variables in `styles/brand.css` and as Tailwind theme extensions in `index.html`.

## 🏗️ Runtime Architecture

Medmorf uses **two separate Transformers.js runtimes** to balance memory efficiency and model compatibility:

| Feature | Runtime | Library | Why |
|---|---|---|---|
| **Translation** | `translation-runtime.js` | `@xenova/transformers@2.17.2` (full CDN URL) | v3 consumed too much memory for the 600M NLLB model |
| **Token-class NER** | `privacy-runtime.js` | `@huggingface/transformers@3.8.1` (import map) | v3 supports modern model architectures (ModernBERT) |
| **GLiNER NER** | `privacy-runtime.js` | `gliner@0.0.19` (esm.sh, externalized) | Uses v3's `AutoTokenizer` via import map alias |
| **LLM verification** | `anonymize-handler.js` | `@mlc-ai/web-llm@0.2.83` (WebGPU) | Qwen3 (0.6B / 1.7B / 4B / 8B) for additional PII verification |

### Why Two Runtimes?

The translation pipeline uses the 600M-parameter NLLB model which requires significant memory. Transformers.js v3 introduced breaking API changes and higher memory overhead that caused OOM issues with this model. The v2 runtime (`@xenova/transformers@2.17.2`) handles it efficiently.

The NER pipeline requires v3 because it supports newer model architectures like ModernBERT (used by `gliner-pii-edge-v1.0`). The translation runtime loads via a **full CDN URL** (`https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2`), which bypasses the import map entirely — so both runtimes coexist without conflicts.

### Import Map Configuration

The `index.html` import map resolves bare specifiers:

```json
{
  "@huggingface/transformers": "...transformers@4.2.0/dist/transformers.web.js",
  "@xenova/transformers": "...transformers@4.2.0/dist/transformers.web.js",
  "onnxruntime-web":         "...onnxruntime-web@1.26.0-dev.../dist/ort.all.min.mjs",
  "onnxruntime-web/webgpu":  "...onnxruntime-web@1.26.0-dev.../dist/ort.webgpu.min.mjs",
  "onnxruntime-web/wasm":    "...onnxruntime-web@1.26.0-dev.../dist/ort.wasm.min.mjs"
}
```

> **WebGPU/JSEP wasm path.** The extern-wasm ORT builds above lazy-load
> `ort-wasm-simd-threaded.jsep.{mjs,wasm}` at runtime to install
> `Module.webgpuInit`. `src/stt-handler.js` sets
> `env.backends.onnx.wasm.wasmPaths` to the exact pinned ORT nightly
> directory so the JSEP glue resolves correctly; otherwise the WebGPU
> backend errors with `Module.webgpuInit is not a function`. The
> service worker also pre-caches those JSEP files (see `CDN_DEPS` in
> `sw.js`) so STT works offline.

The `@xenova/transformers` alias is critical: `gliner@0.0.19` internally `import`s from `@xenova/transformers` (a bare specifier), so the import map redirects it to v3. Without this, gliner would bundle its own v2 copy, which can't tokenize ModernBERT models.

### GLiNER Compatibility Patches

`gliner@0.0.19` was built and tested with DeBERTa-v3 models. Using it with `knowledgator/gliner-pii-edge-v1.0` (ModernBERT) requires two monkey-patches applied in `privacy-runtime.js` after initialization:

#### Patch 1: CLS Token ID

**Problem**: gliner.js hardcodes `CLS token ID = 1` in `encodeInputs()`:
```javascript
let inputIds = [1];  // hardcoded — correct for DeBERTa-v3 only
```
For ModernBERT, `[CLS]` = token **50281**. Sending token 1 (`<|padding|>`) as CLS produces garbage embeddings.

**Fix**: After initialization, probe `tokenizer.encode('a')[0]` to get the actual CLS token ID, then wrap `processor.encodeInputs` to replace the hardcoded `1`. Console output: `[GLiNER] Patched CLS token: 1 → 50281`.

#### Patch 2: ONNX Logits Axis Transposition

**Problem**: The ONNX model for `gliner-pii-edge` outputs logits shaped `[batch, words, entities, 3]` where `3` = start/end/inside (position as the **last** axis). But gliner.js's `TokenDecoder` iterates the flat array as `[position][batch][token][entity]` (position **first**):
```javascript
const positionPadding = batchSize * inputLength * numEntities;
// position = Math.floor(id / positionPadding)  ← expects position-major layout
```
Without transposing, sigmoid outputs are computed from wrong values → zero entities above threshold.

**Fix**: Wrap `onnxWrapper.run()` to detect the `[B, W, E, 3]` layout (last dim = 3, first dim ≠ 3) and transpose to `[3, B, W, E]` before the decoder processes it. Console output: `[GLiNER] Transposed logits: [1,N,23,3] → [3,1,N,23]`.

#### Verification

When GLiNER initializes correctly, you'll see these console messages:
```
[GLiNER] Module loaded, initializing model...
[GLiNER] Patched CLS token: 1 → 50281
[GLiNER] Patched ONNX logits transpose
[GLiNER] GLiNER PII Edge (ModernBERT) initialized
```

During inference:
```
[GLiNER] Transposed logits: [1,245,23,3] → [3,1,245,23]
[GLiNER] Raw results: [{spanText: "Jan de Vries", label: "name", score: 0.95}, ...]
```

### NER Model Options

| Model ID | Engine | Architecture | Best For |
|---|---|---|---|
| `multilang_pii` | Transformers.js v3 | XLM-RoBERTa | Multilingual PII (Dutch, English, French, German) |
| `gliner_pii` | GLiNER | ModernBERT (32M params) | Zero-shot English PII, ~46 MB |
| `multilingual_ner` | Transformers.js v3 | mBERT | General-purpose multilingual NER |

### Known Cosmetic Issues

- **Source map 404s** from esm.sh (`webgpu.mjs.map`, `webgl.mjs.map`, `onnxruntime-web.mjs.map`): These are from gliner's bundled `onnxruntime-web@1.19.2`. The source map files don't exist on esm.sh's CDN. **No runtime impact** — purely cosmetic console noise. GLiNER uses `executionProvider: 'cpu'` so the webgpu/webgl modules are imported but never used.

## 🤝 Contributing

Feel free to:
- Report bugs
- Suggest features
- Submit pull requests
- Share with others

## 📄 License

This project is open source and available under the MIT License.

## 🙏 Acknowledgments

- **Hugging Face** for Transformers.js and hosting models
- **Facebook AI** for the NLLB-200 translation model
- **SheetJS** for excellent Excel handling
- **Mammoth.js** for Word document processing

## 📚 Based On

This project was inspired by translation workflows from [mijnidbcoachnlp](https://github.com/putssander/mijnidbcoachnlp), specifically the translation notebook that used CTranslate2. This browser-based version makes the same functionality accessible without any installation.

## 🌟 Features Roadmap

- [ ] Support for more file formats (CSV, PDF)
- [ ] Batch file processing
- [ ] Translation memory/glossary support
- [ ] Custom model selection
- [ ] Dark mode
- [ ] Offline PWA support
- [ ] Better Word formatting preservation

## ❓ FAQ

**Q: Do I need to install anything?**  
A: No! Just open `index.html` in a modern browser.

**Q: Can I use this offline?**  
A: After the first use (when the model is downloaded and cached), yes!

**Q: How much does it cost?**  
A: It's completely free. No API keys, no subscriptions.

**Q: Is my data safe?**  
A: Absolutely. Everything runs locally in your browser. No data leaves your device.

**Q: Which browsers are supported?**  
A: Modern versions of Chrome, Firefox, Edge, and Safari (with WebAssembly support).

**Q: Can I translate between any two languages?**  
A: Yes! The NLLB-200 model supports 200+ languages. You can add more to the dropdowns.

**Q: Why is the first translation slow?**  
A: The model needs to be downloaded first (~300MB). After that, it's cached and translations are fast.

---

**Made with ❤️ using Transformers.js**

Happy translating! 🌍
