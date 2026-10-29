# Medmorf - Medical Data Transformation

<p align="left">
  <img src="assets/brand/logo-horizontal.svg" alt="Medmorf" height="56">
</p>

Medmorf is a static, client-side PWA for transforming medical data in the browser. It can translate text and documents, anonymize PII, redact PDFs, summarize clinical documents, transcribe speech, index/sort DICOM folders, merge PDFs, and manage offline model caches.

User content is processed locally in the browser. The app has no backend, no analytics, no cookies, and no server-side processing. Network access is used to download public app dependencies, fonts, OCR data, and model weights from CDNs/model hosts; the files and text you process are not uploaded.

## Live Site

Production: **https://medmorf.com** (GitHub Pages, custom domain; deploy-on-push from `main` via GitHub Actions).

Cloudflare Pages deployment: https://medmorf.pages.dev — same code, served with the cross-origin isolation headers from `_headers`, so WASM runs multithreaded there (see [Cross-origin isolation](#cross-origin-isolation-multithreaded-wasm)). medmorf.com does not have those headers yet; moving the domain to Cloudflare is the pending step.

After the first visit and model download, the service worker and browser caches allow the app shell and cached models to work offline.

## What Medmorf Does

| Area | Current capability |
| --- | --- |
| Translate | Text translation plus `.xlsx` and `.docx` upload workflows using NLLB-200. Excel translation preserves sheets/columns and writes translated columns to a new workbook. |
| Anonymize | PII detection and replacement for pasted text or `.pdf`, `.xlsx`, `.docx`, and `.txt` uploads. The Advanced settings use two model panels: NER / detector on the left and LLM on the right. When feasible, the default is Multilingual BERT NER + Qwen3.5 2B, the combination with the highest published F1; devices that cannot run Qwen fall back to GLiNER PII Edge alone, the best detector-only F1. A test keeps these defaults in line with the generated benchmark. Choices a user made explicitly are kept. Hybrid validation is conservative: real PII is kept even when the detector type is imperfect. LLM output passes deterministic sanity filters (must be a verbatim quote of the chunk; roles, labels and non-identifier values are dropped and listed in a collapsible "dropped by sanity filters" table). Detection chunks use overlap to preserve context across boundaries. The result panel is a review surface: every mapping row has an on/off checkbox (off = original text kept, row greyed, still listed), a source badge (NER / LLM / manual), a context quote and occurrence count ("not in text" flags phantom entities), and a "Show in text" control that unfolds every occurrence and jumps to it in the preview. The preview can show the original text with colour-coded highlights; clicking a highlight opens prev/next, turn-off and delete controls. A multi-level Undo covers every mapping edit, and edits re-apply instantly to text and Excel output before download. For `.xlsx` runs the results open with a sheet summary: rows with PII out of all data rows, cells changed out of the text cells in the selected columns, replacements per entity type, and cells and rows with PII per column. It is recomputed on every mapping edit and counts matches of detected entities only; numeric cells are not scanned. The Excel preview lists only rows that contain PII (the first 50, in sheet order, with sheet row numbers and only the cells holding detections) instead of the whole sheet; "Show in text" for an occurrence beyond those rows pins its row on top. The download still contains every row. `src/anonymize-excel-stats.js` maps detections in the joined cell text back to sheet rows and columns. `?anon-debug=1` exposes `window.medmorfAnonymizeData.debugSeed({ text, entities })` (or `{ rows, columns, entities }` for a sheet) to exercise this panel without loading a model. PDF read failures are shown as plain user-facing messages with retry guidance. |
| PDF redaction | Integrated into Anonymize. Exports burn-in redaction PDFs by default, plus anonymized text (`.txt`) or PDF text rebuilds. Burn-in output rasterizes pages and removes original glyph/image text. Scanned pages can use OCR. |
| Summarize | WebGPU clinical summarization from pasted text or `.xlsx`, `.docx`, and `.txt` files. Templates include Dutch psychological report, SOAP note, and free-form summary. |
| Speech | Whisper transcription for microphone recordings or uploaded audio (`.mp3`, `.wav`, `.ogg`, `.webm`, `.m4a`, `.flac`, `.mp4`). Includes a dictaphone mode that can export `.xlsx` logs. |
| DICOM | Browser-based folder scanning, DICOM metadata indexing, modality filters, JSON/XLSX export, proposed sort previews, and generated PowerShell/robocopy scripts. Requires the File System Access API for folder workflows. |
| Merge PDF | Client-side PDF merge using `pdf-lib`. |
| Data prompt | Local CSV/TSV/XLSX/JSON profiling, optional Qwen3.5 2B description suggestions, missing-context checklist, and reviewed synthetic-generation prompts saved as text or copied manually. |
| Storage | Cache status, model preloading/clearing, app update refresh, and offline dependency checks. |

## Privacy and Healthcare Safety

- 100% client-side processing: no uploaded files, pasted text, audio, PDFs, or DICOM data are sent to a backend.
- No analytics, tracking scripts, cookies, telemetry, or account system.
- Use Storage → Clear all personal data to clear exposed in-memory analysis state. Data prompt also has Clear workspace and discards its previous state on a new selection. There is no automatic 30-minute inactivity timer. Saved files and clipboard contents are not erased by these controls.
- Models and libraries are fetched from public CDNs/model hosts and then cached by the browser.
- You can inspect the runtime privacy report in DevTools with `window.medmorfSecurity.getPrivacyReport()`.
- Outbound-data audit of 2026-09-10 ([docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)): every remote request is a `GET` of code, fonts or model files; no request carries document text, audio, identifiers or mappings; third-party bundles contain no telemetry. The page sends no referrer, and identifier-level console logging is off unless `?anon-debug=1`.

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

- On iPhone/iPad, ONNX sessions run without ORT's CPU memory arena (`enableCpuMemArena: false`) — its contiguous first-inference pre-allocation crashed real iPhones during Whisper warm-up (found via crash-stage telemetry + URL-flag bisection). On iPhone/iPad, Summarize offers only Qwen3 0.6B (~1.4 GB) — the largest model empirically known to run on a real iPhone; Qwen3.5 0.8B (~1.63 GB) and up crashed an iPhone 17 Pro during load and are disabled there. Anonymize's LLM pipeline (2B minimum) stays blocked on iOS and falls back to NER-only; Speech and Translate work on iOS.

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
| Data prompt | Folder or multiple `.csv`, `.tsv`, `.xlsx`, flat-record `.json` files | Editable synthetic-generation prompt, `.txt` download, clipboard |
| Speech | Microphone, `.mp3`, `.wav`, `.ogg`, `.webm`, `.m4a`, `.flac`, `.mp4` | Transcript text; dictaphone log `.xlsx` |
| DICOM | Local DICOM folders/files (`.dcm`, `.dicom`, `.dic`) | Index `.json`, index `.xlsx`, PowerShell/robocopy script, sorted folder copy |
| Merge PDF | Multiple PDFs | Merged PDF |

## Data prompt workflow

Before any dataset inference, the local engine must pass a small two-column fictional JSON/schema check; if it fails, the run stops before sending file samples to the model. Safe diagnostics show only response character/token counts, finish status, wrapper flags and whether JSON can be parsed (never response text or source snippets). The parser accepts one complete JSON object inside a code fence, a completed leading thinking block, or explanatory prose; it rejects incomplete or ambiguous multiple objects. Parse failures are distinguished from missing schema fields. Related-column groups stay together during malformed or incomplete response repair; successful draft fields are retained. This is tested with simulated responses; live model behaviour still requires browser verification.

The Data prompt picker reads selected files into browser memory; it does not upload them or persist them in browser storage. Browsers may use “upload”/site-trust wording in their own folder-picker dialog; the app explains this before selection but cannot change browser-owned text. Pickers enable only after the local file tools initialise; startup failures show an actionable reload message. Native input selection is reset after capturing File objects, so choosing the same files again starts a fresh read. Cancelling preserves the existing analysis. Busy, per-file reading, unsupported-input and unexpected analysis failures receive visible feedback.

The Data prompt workspace has two independent scopes. **Phase 1** immediately shows measured descriptors after import and builds a copyable/saveable prompt without a model or required free text. It includes file/table aliases, editable table names, row counts, column names, observed types and selected per-column descriptive statistics. Headers and statistics start enabled in this workspace; users can withhold each before reviewing the exact prompt. **Phase 2** optionally adds editable file/column descriptions, roles, units, generation rules, synthetic examples, a generation brief and unverified harmonisation notes. Its local assistant is optional. The scope selector always permits returning to Phase 1, which excludes all Phase 2 content even after AI has run. The export panel precedes the optional assistant. AI failures, cancellation and missing WebGPU do not block Phase 1; both scopes still require review before Copy/Save. Only complete AI runs automatically open the enriched scope; manual Phase 2 editing does not require AI completion. Harmonisation suggestions identify possible terminology families or missing context, not verified concept mappings; there is no terminology database, SNOMED/LOINC lookup or automatic code validation. The pinned WebLLM 0.2.83 runtime now receives explicit `response_format: { type: "json_object", schema }` schemas for file, column and brief tasks; JSON is constrained during generation, not merely requested in text. Invalid/incomplete model replies are retried once per task, with task-specific feedback distinguishing malformed JSON, token-limit truncation and missing fields. Valid fields are retained. Individual-column tasks retry only affected fields; combined tasks keep the whole dependent group together. The role example uses a single valid value rather than an ambiguous pipe-separated placeholder. Two consecutive exhausted task failures stop the run early instead of processing every file; inference/runtime failures stop immediately. Completed file/column tasks and validated grouping plans are kept in page memory for retry, so resuming reuses the same groups and skips completed work. The button shows the retained task count. Reloading, replacement, cleanup or successful completion clears this memory; nothing is automatically persisted. A Stop analysis button interrupts generation. Inference streams internally while drafts remain hidden: progress shows character counts and elapsed/task-budget seconds, never partial text. Requests have a token-budget-based deadline (120–300 seconds; 270 seconds for a 1,800-token group) plus a separate 90-second no-progress limit. A timeout interrupts inference and stops the run immediately; it is reported as a timeout rather than repeated model failures. Model download/loading time is separate. These are bounded budgets, not a guarantee of completion on every device. Truncated responses get one bounded retry with twice the token budget (maximum 1,800). Inference failures are reported separately; failures or missing required fields report retry feedback while Phase 1 stays usable. Unsupported WebGPU and cancelled loads also leave Phase 1 available. Unknown/confirm drafts can be complete fields without being verified facts. Generation rules are editable AI-drafted instructions for producing consistent values; optional masks and export switches need not be populated. The assistant proposes purpose, population, relationship rules, starting row count and output format. Progress shows model preparation/loading, file understanding, column drafting, brief writing and draft application, with processed-task counts, elapsed time and per-task failures. Progress counts attempted tasks, not guaranteed successful inference. Pending drafts are discarded if the workspace changes during analysis; errors leave existing fields intact.

Column names are included in prompts by default; users can disable each name in its table row. The workspace also has an **Include statistics for all tables** switch to enable or disable per-column statistics across the entire analysis in either prompt phase. It updates existing table/column controls without rebuilding the tables, shows mixed selection, and preserves names and locally displayed measurements. Table row counts in the Phase 1 schema remain included. Each table header also provides **All column names** and **All statistics** switches, applying only to that table. A mixed checkbox indicates that some columns are enabled; individual column switches remain available. Bulk changes update those switches and example headers in place, batch prompt rebuilding, and reset export review. Review headers for identifying information. Local AI can classify a column as identifier, reference, measurement, category, boolean, datetime, free_text or unknown, with an editable role selector. Its local evidence includes header hints, non-missing/distinct counts, uniqueness fraction, leading zeros and dominant abstract letter/digit shape (at least 80% coverage). These are hints, not proof of semantics. Numeric IDs must be treated as identifiers rather than continuous measurements; repeated reference IDs do not imply uniqueness or establish a join. Classified identifiers get a locally validated proposed format, using the abstract shape when the model leaves the mask blank. Mask generation does not validate UUID, date or checksum rules. Roles and descriptions remain reviewable AI drafts; AI does not change aggregate export switches.

Identifier formats can be entered in each column’s row in the profile table: `A` = uppercase letter, `a` = lowercase letter, `9` = digit (e.g. `AA-999999`). Other ASCII letters/digits and `- _ . /` are literals; backslash escapes a slot character. Formats are limited to 64 characters and require at least one variable slot. Three distinct unused IDs are generated as strings, preserving leading zeros, and checked against normalized source-column values. Identifier mode overrides numeric range and binary reuse rules. Exhausted formats or bounded-search failures block preview export with a visible message. Formats and string/uniqueness requirements enter the prompt; values require the preview export opt-in. IDs are illustrative and deterministic, not security tokens; no automatic cross-table key linkage is provided.

Phase 2 first asks the local model to plan each table’s column tasks from headers/types and at most two snippets already drawn from the first five rows. The instruction prefers singleton tasks and the smallest necessary dependency group: shared topics, nearby positions or common prefixes alone do not justify grouping. Each group must explain why joint interpretation is needed. `src/data-column-plan.js` validates that every alias appears exactly once, with no unknown aliases and groups of 1–4 columns. Invalid plans are retried once and then stop Phase 2; larger dependencies must be flagged for cross-group review rather than claimed solved. The planner output determines the actual inference requests, replaces arbitrary consecutive four-column batches, and is shown beside column roles and in Phase 2 exports. It is an unverified hypothesis, not a proof of independence. Phase 1 excludes plans and generated examples. Tests cover singleton/pair routing, malformed plans, general categorical examples, aligned rows and source-collision repair; live Qwen quality remains unverified.

Text columns also show **Observed text values** with exact-string counts and percentages of non-missing cells, plus a per-column export toggle in both phases. Values default on only when there are at most 20 distinct values, every value occurs at least five times, distinct/non-missing is at most 20%, and all values are at most 120 Unicode code points. Otherwise they default off with reasons; the user can override this after review. These are frequency heuristics, not identifier detection or anonymity guarantees. At most the 20 most frequent values are retained for display/export, each capped at 120 code points with truncation flags and an omitted-distinct count. Values are included only when both **Statistics** and **Observed text values** are enabled; table/analysis statistics switches also gate this export without changing the value preference. Data cells are rendered as text. The private value summaries are cleared on replacement and sensitive-state cleanup. They do not expand the local model's first-five-row sample limit.

Each table has a three-row synthetic preview (`src/data-synthetic-preview.js`). Preview headers and exported example-row keys follow each column's **Column name** switch: original headers by default, aliases when disabled. If a mixture produces duplicate names, examples are blocked instead of silently dropping values. Checkbox changes reset review immediately and batch prompt rebuilding after 100 ms of inactivity; column-name changes update the preview immediately without rebuilding the full editing table. Numeric candidates stay within the observed range and preserve inferred integer/decimal type; a bounded search may fail and then blocks the preview instead of silently copying source values or inventing out-of-range numbers. Before AI enrichment, text uses fixed fictional placeholder sentences. Phase 2 requests three meaning-based synthetic values for each column, with corresponding array positions forming a proposed row for combined groups. Model examples are checked for observed type, numeric range/integer kind, a 120-code-point text limit, and source collisions (numeric equality or NFKC/trim/case-folded text). Invalid examples trigger one bounded repair; unrepaired examples block their preview. IDs continue to use the validated mask generator. These checks do not validate vocabulary membership, clinical meaning, cross-column consistency or anonymity. The model can propose alternatives from recognised public categories; no country-specific rules or vocabulary are bundled. Boolean values, genuine two-valued 0/1 columns and nulls may repeat. A column containing only fixed generic labels (yes/no/unknown/pending/complete/active/inactive) has a separate explicit reuse option. Two arbitrary labels are never assumed safe. Normalized source-value sets are retained in a private in-memory WeakMap for identifier collision checks; they are excluded from model inputs, serialization and exports and cleared on replacement or sensitive-state cleanup. Synthetic candidates and eligible fixed generic labels are also retained. Preview export is separately opt-in and changing reuse resets review. Checks are per-column, not dataset-wide; novelty does not establish anonymity, distributional fidelity or valid relationships. Rows made entirely of exempt values may match real rows.


The **Data prompt** tab profiles a selected folder or files entirely in browser memory. Its responsive workspace has folder/file selection cards, live file/table/row/column totals, individual file cards, a unified editable column table with sticky names/headers and measured statistics alongside meanings, units, rules, ID formats, reuse and per-column export switches (column names on by default), synthetic example rows directly below each table, the local assistant followed by an AI-drafted generation brief, and a dedicated prompt editor with review/export controls. Extended format and privacy guidance is available in expandable sections. It reuses SheetJS 0.18.5 and computes deterministic statistics in `src/data-profile.js` without a new dependency: column names, row counts, inferred type (integer/decimal, text, boolean or empty), non-missing counts, missing counts/percentages, and distinct counts. Numeric values and text lengths have min, max, mean, sample SD (n − 1), median, Q1, Q3 and IQR; population SD is retained in the structured profile. A visible summary table presents these measurements for each source table. Boolean columns show true/false counts and percentages of non-missing values. Text lengths count Unicode code points, including whitespace. Missing cells are excluded; sample SD is undefined for n=1; quartiles use linear interpolation. Text-value frequencies are retained separately in a private in-memory WeakMap; they are not part of the serialized profile or additional model input. Text columns also have local structural profiles (`src/data-text-profile.js`): multiline text, irregular whitespace, numbers, possible shorthand, English/Dutch negation keywords, lists, delimiters and non-ASCII characters. Each reported pattern must occur in at least five non-empty cells and is labelled common (at least half) or occasional. Descriptions, challenges and fictional examples use a fixed vocabulary, never source substrings or paraphrases; no entity names, organisations, locations or source numbers are extracted. These patterns/examples are displayed in table-cell details and separately opt-in for prompt export. This is heuristic formatting analysis, not semantic interpretation, anonymization or a guarantee against identifying aggregates. CSV/TSV must have headers; JSON must contain flat records. Empty rows are ignored; mixed numeric/text columns are treated as text, and numeric-looking identifiers need explicit rules. Dates are not inferred (Excel date cells may appear as serial numbers). Categories, cross-column correlations, keys and relationships are not inferred; users supply their domain meaning and dependencies.

Limits are 5 MB/file, 10 MB/selection, 20 tables, 200 columns total, 20,000 rows and 100 columns/table. Parsing runs on the main thread, yields between files, and bounds worksheet rows; complex compressed workbooks can still consume substantial memory. Errors and unsupported files are reported; valid tables remain usable. A new selection replaces the previous profile.

Optional Qwen3.5 2B (`Qwen3.5-2B-q4f16_1-MLC`, existing WebLLM 0.2.83, approximately 2.2 GB) examines local headers, summaries and bounded source-cell samples in small model-planned groups and drafts likely subject matter, record meaning, writing style and challenges. Only cells from the first five data rows after the header are retained per column in a private WeakMap, capped at 120 UTF-16 code units per cell; empty cells do not cause sampling from later rows. Full-file JavaScript statistics and ID collision checks still run locally. These are not representative samples. File-level inference gets at most eight columns with two 120-code-unit samples each, plus up to four compact table summaries. Samples go only to explicitly requested local WebLLM inference, never directly to exports or persistence; replacement/cleanup clears them. Inference explicitly disables Qwen thinking mode (`extra_body.enable_thinking: false`) and requests concise JSON with 350 tokens for file descriptions, 1,800 for each table’s grouping plan, 900 for individual columns, 1,800 for combined groups and 600 for the brief. Compact evidence avoids sending verbose pattern explanations. It requires desktop WebGPU, is blocked on iPhone/iPad, loads only on request, uses the shared heavy-load lock and unloads after the run. Phase 1 profiling and its prompt remain available without a model or completed Phase 2 drafts. First use downloads dependencies/model files; cached resources are required offline. The explicit “Run optional Phase 2” action requests bounded JSON drafts and populates empty file descriptions, column meanings/units/rules, optional proposed ID masks, and the purpose/relationships brief in place. Manual text is preserved. Untouched earlier AI drafts may be refreshed, using per-field provenance; source data never changes. Invalid JSON is reported and skipped. Unsupported fields are ignored; the model cannot change export switches or measured statistics. Drafts are marked for review and may enter the editable prompt; export still requires review of that exact prompt. The model proposes a starting row count (validated integer from 1 to 1,000,000) and an allowed output format, clearly subject to review; manually edited selections are preserved. File and column drafts inform the final brief, with bounded evidence. Proposed ID formats must pass local generation checks and are not presented as observed formats. A changed/cleared workspace discards pending drafts. Draft validation/application is in `src/data-prompt-drafts.js`.

Folder selections show a separate overview and editable description for each file, including its local relative path to distinguish duplicate filenames in subfolders. File groups are displayed alphabetically by their relative path, with Excel sheets sorted alphabetically within each file (case-insensitive, with natural number ordering). Display sorting preserves existing table aliases and prompt references. Users provide each file’s purpose and row meaning, overall purpose/population, target rows, output format, dependencies, and per-column meaning, units and rules. Missing file descriptions are counted in the checklist. Qwen drafts file descriptions in place using bounded header summaries (up to 12 columns per table) and limited local content samples. Exported tables retain stable aliases and include an editable table name in both phases. The name defaults to the filename without its extension for CSV/TSV/JSON, or the worksheet name for XLSX. Each table heading has a **Table name in prompt** field: replace identifying parts or leave it blank to export only its generic table alias as the name. Edits reset export review; AI does not overwrite this field. Original source labels remain visible locally, and folder paths are excluded from exports. Phase 2 also includes the file description. A checklist counts missing context, not data sufficiency, clinical validity or privacy. Prompts use generic table aliases and include original column names by default (each row can switch its name off to use a column alias), omit folder paths and source sample rows, but may include enabled observed text-value summaries, and include measured statistics by default in the workspace, with per-column switches to withhold them before export. **Aggregates, user-written descriptions and AI drafts can still disclose sensitive information**; this is not anonymization. Review the exact editable prompt before enabling Save/Copy. Field changes rebuild the draft and reset review. Download saves a `.txt` file; clipboard transfer to a frontier model is manual. No prompts or source files are uploaded or automatically persisted. Global sensitive-state cleanup includes this tab; downloaded files and clipboard contents are outside that cleanup.

Startup/import check: `node --experimental-default-type=module tests/test-data-prompt-startup.mjs` (unmodified module imports and IDs from the actual HTML). Planning/example check: `node --experimental-default-type=module tests/test-data-column-plan.mjs`. AI-draft checks also cover streamed progress, cancellation, stalled output and request deadlines; handler checks cover grouping-plan reuse after failure. AI-draft check: `node --experimental-default-type=module tests/test-data-prompt-drafts.mjs`. Synthetic-preview check: `node --experimental-default-type=module tests/test-data-synthetic-preview.mjs`. Text-pattern regression check: `node --experimental-default-type=module tests/test-data-text-profile.mjs`. Regression checks: `node --experimental-default-type=module tests/test-data-profile.mjs` and `node --experimental-default-type=module tests/test-data-prompt-handler.mjs`. The handler test covers descriptors-only export without AI, scope switching, Phase 1 availability after model failures, batched toggles, review resets, local import, unavailable WebGPU, malformed input, cleanup during pending file reads and a mocked AI run verifying brief suggestions, progress and preservation of manual edits. It does not run actual model inference or a real browser.

Fictional-example tests: `node --experimental-default-type=module --test tests/test-data-prompt-examples.mjs`. The 17 cases use `tests/fixtures/data-prompt-responses.json` (handwritten examples, not recorded model responses) to check JSON wrappers, truncated four-column output, malformed/ambiguous responses, partial repair, unknown/duplicate aliases, brief validation and metadata diagnostics. `tests/fixtures/data-prompt-folder/` contains two entirely fictional files, `records.json` and `visits.json`, for statistics, leading-zero IDs, references, dates, nullable values, bilingual notes and strict first-five-row sampling. Select that folder in the Data prompt tab to try actual local inference without real data. These automated tests run offline without model downloads; passing them does not establish that Qwen produces valid responses.

## Runtime Architecture

Medmorf is intentionally a static vanilla-JS app:

- No bundler, no backend, no server folder, and no runtime package install.
- `index.html`, `manifest.webmanifest`, and `sw.js` stay at the repo root for PWA scope.
- Client-side JavaScript lives in a flat `src/` directory and uses sibling-relative module imports.
- CSS is split between `styles/styles.css` for older component styles and `styles/brand.css` for brand tokens/overrides.
- `sw.js` uses `CACHE_NAME = 'medmorf-app-v67'` for the app shell and CDN dependency cache. Model weights are kept separately by WebLLM, Transformers.js, IndexedDB, and the Cache API.

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
| NER | `Xenova/bert-base-multilingual-cased-ner-hrl` default detector (paired with Qwen3.5 2B), `knowledgator/gliner-pii-edge-v1.0` CPU fallback when Qwen cannot run, `onnx-community/multilang-pii-ner-ONNX`, `openai/privacy-filter` (WebGPU only) |
| Summarize | `Qwen3-0.6B-q4f16_1-MLC` (iPhone-only tier), `Qwen3.5-0.8B-q4f16_1-MLC`, `Qwen3.5-2B-q4f16_1-MLC` (default), `Qwen3.5-4B-q4f16_1-MLC` |
| Speech | `onnx-community/whisper-tiny`, `onnx-community/whisper-base`, `onnx-community/whisper-small`. Whisper small is the default on desktop; on iPhone/iPad the default is Whisper base and small is disabled (small's load rebooted the page on a real iPhone 17 Pro). See the Benchmark page for published measurement availability. The browser's built-in dictation (Web Speech API) is deliberately not used: it gives no on-device guarantee. |

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
|   |-- benchmark-report.mjs
|   |-- build-interview-fixture.mjs
|   |-- convert-meddeid.mjs
|   |-- deploy-pages.sh
|   |-- dev-server-isolated.mjs
|   `-- stamp-build.sh
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
|   |-- BENCHMARKS.md
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
|   |-- anonymize-filters.js
|   |-- anonymize-excel-stats.js (Excel cell index, sheet summary and PII-row preview data)
|   |-- benchmark-published.js (generated: measured numbers shown in the app)
|   |-- llm-extract.js
|   |-- text-chunking.js
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
|   |-- data-text-profile.js
|   |-- data-synthetic-preview.js
|   |-- data-column-plan.js (validates model-proposed column groups)
|   |-- data-prompt-drafts.js
|   |-- data-profile.js
|   |-- data-prompt-handler.js
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
    |-- test-data-text-profile.mjs (structural patterns and source-detail exclusion)
    |-- test-data-synthetic-preview.mjs (novelty checks, exemptions and blocked constraints)
    |-- test-data-prompt-drafts.mjs (validated draft application and preservation of edits)
    |-- test-data-profile.mjs (statistics and export boundaries)
    |-- test-data-prompt-handler.mjs (handler events and sensitive-state cleanup)
    |-- test-data-prompt-startup.mjs (unmodified imports, file readiness, reselection and errors)
    |-- test-data-column-plan.mjs (minimal supplied groups and general model-example validation)
    |-- test-data-prompt-examples.mjs (17 fictional response and folder regression cases)
    |-- test-models.html
    |-- test-benchmark-published.mjs (validates generated metrics against the raw export and the Anonymize defaults against the best F1)
    |-- test-anonymize-excel-stats.mjs (Excel row numbers, PII-row summary, 20k-row timing)
    |-- metrics.js
    |-- fixtures/
    |   |-- data-prompt-responses.json (handwritten valid, malformed and truncated model-output examples)
    |   |-- data-prompt-folder/ (fictional records.json and visits.json for unit and manual model tests)
    |   |-- anonymize.json
    |   |-- anonymize-interview.json
    |   |-- anonymize-meddeid.json
    |   |-- interview-gold/ (gold_phi_annotations.json, gold_reidentification_risks.json)
    |-- benchmark-results/ (raw Benchmark-tab exports + notes per run, e.g. 2026-09-10-anonymize.json)
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

The app interface uses a narrow, iOS-inspired grouped layout with restrained surfaces, touch-sized controls, and horizontally scrollable tool navigation on small screens. Each tool follows a numbered input → options → action → result path; optional document modes, mapping files, model controls, and technical guidance stay in expandable disclosures so the primary workflow remains concise without weakening privacy or healthcare-safety information. Model downloads use a compact confirmation showing only download size, local-processing privacy, and any essential device warning; technical estimates remain available under Details.

## Accuracy and WER

The [Benchmark page](https://medmorf.com/#benchmark) is the single public reference for model measurements, organized by tool. The top banner and each tool’s accuracy guidance link there. Anonymization results show recall, precision and F1 for each synthetic dataset, ordered by F1 by default; Sort by buttons reorder them by recall or precision, and the app's default combination is tagged; other tools explicitly state when no reproducible run has been published. Optional local runs stay folded under each tool, with shared settings and exports below.

Recall measures identifiers found, precision measures correct detections, and F1 balances both. All three published anonymization metrics are computed per document and averaged. Speech uses word error rate (lower is better), translation uses chrF, and summarization uses fact coverage and hallucination probes. Synthetic results do not guarantee performance on real clinical material: always review outputs.

## Long recordings

Historical runtime observations and their limitations are kept on the [Speech benchmark page](https://medmorf.com/#benchmark-speech).

Guidance built into the Speech tab: for long sessions on a phone use **Dictaphone** mode (each entry is transcribed while you talk the next one, so nothing waits at the end); for a single long recording keep the tab in the foreground until it finishes. Before the ORT proxy worker was enabled, the same transcription froze the page on iOS — that was the "hang".

## Cross-origin isolation (multithreaded WASM)

**Hosting:** production **medmorf.com** is served by GitHub Pages, which ignores `_headers` — so production currently runs **single-threaded**. The Cloudflare Pages deployment (`https://medmorf.pages.dev`, project `medmorf`) serves the same code with the isolation headers active and is cross-origin isolated. Redeploy it with `tools/deploy-pages.sh` (clean `git archive` of HEAD), or connect the repo in the Cloudflare dashboard for deploy-on-push. Remaining migration steps to make medmorf.com isolated: add the custom domain to the Pages project → move medmorf.com's nameservers to Cloudflare → verify in the console that `crossOriginIsolated === true` and that CDN assets (jsDelivr, HF, cdnjs, Tailwind) still load. Browsers without `COEP: credentialless` support ignore the header and stay single-threaded — never broken.

Without `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers a page gets no `SharedArrayBuffer`, so ONNX Runtime WASM runs **single-threaded**. Runtime observations are documented on the [Speech benchmark page](https://medmorf.com/#benchmark-speech).

`COEP: credentialless` is the header to use — `require-corp` blocks the Tailwind CDN and the Inter font (no CORP headers), `credentialless` keeps everything loading and still isolates. For local testing: `node tools/dev-server-isolated.mjs` (port 8001). For production hosting add both headers (e.g. Cloudflare Pages `_headers`):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

Note: Safari's support for `credentialless` should be verified on target iOS versions before shipping the headers; with `require-corp` the Tailwind/Inter tags would need `crossorigin` attributes and CORS-enabled hosts instead.

## Model Benchmark

**Published measurements:** [medmorf.com/#benchmark](https://medmorf.com/#benchmark). The single source for the anonymization numbers is the raw export in `tests/benchmark-results/`. `tools/benchmark-report.mjs` generates both `src/benchmark-published.js` (consumed by the Benchmark page) and `docs/BENCHMARKS.md` (the detailed downloadable report). Do not copy scores into the README, tool panels or model-selection buttons.

Regenerate both outputs together:

```bash
node tools/benchmark-report.mjs tests/benchmark-results/2026-09-10-anonymize.json --intro tests/benchmark-results/2026-09-10-anonymize.notes.md --summary-js src/benchmark-published.js > docs/BENCHMARKS.md
```

Verify generated metrics with `node tests/test-benchmark-published.mjs`. The Excel summary helpers are checked with `node tests/test-anonymize-excel-stats.mjs`.

F1 is the mean of per-document F1 scores, including for computed detector + LLM unions. Published data renders before any device probes or fixtures load; opening a local-run disclosure initializes the benchmark harness. Running locally does not overwrite published data. The generator orders the report tables by F1 and records the union with the highest F1 averaged over the datasets as `best`; `node tests/test-benchmark-published.mjs` fails if the Anonymize defaults differ from it or from the best detector-only F1. `#benchmark` and per-tool routes such as `#benchmark-anonymize` work on direct visits, reloads and browser history navigation.

The **Benchmark** tab in the app (also standalone at `http://localhost:8000/tests/test-models.html`; logic in `src/benchmark-handler.js`) loads every model option per tab — NLLB translation, the four NER detectors, Whisper tiny/base/small, and the WebLLM LLMs for Anonymize and Summarize (the app's Qwen3.5 0.8B/2B/4B plus Qwen3 0.6B/1.7B/4B as reference baselines, all from the pinned WebLLM 0.2.83; anything larger — Qwen3 8B, Qwen3.5 9B, Qwen3.6/3.8 at 27B+ — is excluded as not browser-viable) — and runs each on synthetic fixtures in `tests/fixtures/` (fictional patients, no real data). For every model it records load time, inference time per document, peak JS heap delta (Chromium only) and a task quality score computed by `tests/metrics.js`:

- Anonymize (NER and LLM): PII **recall** per type (a miss is a leak), precision against annotated spans and document-averaged F1; the LLM uses the exact prompt from `src/anonymize-prompts.js`, documents are chunked with the app's `src/text-chunking.js` settings, and LLM output goes through the app's sanity filter (`src/anonymize-filters.js`), so numbers reflect what Anonymize really keeps. A **NER + LLM union** table computes the hybrid pipeline's recall for every detector × LLM pair from the stored predictions, so combinations need no extra runs.

Anonymize can be run on three fixture sets (selector in the tab):

| Set | File | Content |
| --- | --- | --- |
| App fixtures | `tests/fixtures/anonymize.json` | 4 short synthetic notes, NL + EN, with `allowed` clinical terms |
| Oncology interview | `tests/fixtures/anonymize-interview.json` | 1 long synthetic Dutch patient interview (~34k chars, transcript style) with two gold layers from `tests/fixtures/interview-gold/`: 64 direct and standard identifiers (gold label and recommended action kept per item) for entity-level recall / precision, and 18 re-identification risk groups (77 quasi-identifier elements such as age + profession + town, treatment timeline, household structure) plus 23 clinical concepts that must be retained. Rebuild with `node tools/build-interview-fixture.mjs [transcript.md]`. |
| MedDeID sample | `tests/fixtures/anonymize-meddeid.json` | 24 documents from the MedDeID Dutch synthetic benchmark (Belgian-Dutch clinical notes, physician-reviewed, no real patients): all 8 "targeted-difficult" documents plus 16 seeded-random ones. Source: Hellemans et al., University of Antwerp / UZA, CC BY 4.0, [doi:10.5281/zenodo.21890965](https://doi.org/10.5281/zenodo.21890965). Regenerate with `node tools/convert-meddeid.mjs <unzipped-archive-dir>`; every item keeps its original MedDeID label. |

Fixture format: `{ types, documents: [{ id, language, text, pii: [{ text, type }], allowed: [], retain?: [], riskGroups?: [] }] }`. Entity scoring is whole-word text overlap either way (case- and diacritic-insensitive; "Noor" does not match "Noorderlicht"), type ignored for recall; comparable between models but not with span-level evaluations such as MedDeID's. Documents with `riskGroups` / `retain` (the interview) additionally get the harder question — could someone still re-identify the person after the obvious identifiers are gone? — via `scoreReidentification` in `tests/metrics.js`:

- **quasi-ID** — share of gold quasi-identifier elements neutralised (an element counts when a prediction overlaps it or is a sub-phrase of it, e.g. flagging "Gouda" neutralises "vader van 79 woont in Gouda");
- **risk groups** — groups with at least half of their elements neutralised (a heuristic; per-group counts are in the detail text);
- **over-redaction** — share of the clinical concepts to retain that a detector would replace (lower is better).

A perfect direct-identifier detector neutralises most groups but not those built from profession, employment pattern or clinical detail; the MedDeID set carries **PROFESSION** items for the same reason. The app does not detect professions yet, so read those rows as a known gap.
- Translate: **chrF** against reference English.
- Summarize: **fact coverage** from a checklist plus hallucination probes.
- Speech: **WER** for Dutch and English clips (macOS TTS audio; real dictation scores worse).

Models are run sequentially and disposed between runs; models above the device's safe ceiling are skipped unless overridden. Results can be exported as JSON or copied as a Markdown table. Run it in Chrome/Edge for heap numbers and WebGPU; Safari/Firefox show `n/a` for heap.

## Roadmap: Ollama as an optional local backend (planned, not implemented)

Status: **TODO** — design agreed on 2026-09-10, no code yet. Nothing in the app contacts Ollama today.

**Why:** the browser's per-tab memory ceiling caps the LLM pipeline at Qwen3.5 4B and requires WebGPU. A locally installed [Ollama](https://ollama.com) runs Qwen3.5 9B and larger with native Metal/CUDA acceleration, needs no WebGPU, and would let desktop Safari and low-RAM laptops use the LLM pipeline. Data still never leaves the machine: the app would talk only to the Ollama process on the same computer.

**Where it lives:** an opt-in toggle under **Advanced settings → LLM** in the Anonymize and Summarize tabs (default off). When on, the LLM model cards list the models Ollama has pulled (`/api/tags`), with Qwen3.5 preferred because it is the benchmarked family; the NER / detector panel is unaffected. The Benchmark tab scores Ollama models with the same fixtures and metrics as the in-browser models.

**How it works:** `llmChat()` in `anonymize-handler.js` and `summarize-handler.js` gets a second backend that posts the same messages to `http://localhost:11434/api/chat` (thinking disabled, same temperature / token limits). A two-step probe decides what to show: a `no-cors` request tells whether anything listens on port 11434; a normal request tells whether Ollama accepts this origin. That yields three states — *not running*, *running but rejecting this site* (shows the setup card below), *ready*. Constraints: loopback addresses only (`localhost` / `127.0.0.1`, never a user-typed URL), opt-in per session, unavailable on iPhone/iPad, and documented in `docs/PRIVACY.md` before shipping.

**User setup for medmorf.com (one-time):** Ollama only trusts pages served from `localhost` by default, so users must allow the site's origin. The value is the exact origin, no path or trailing slash; add `https://www.medmorf.com` comma-separated if that host serves the app too.

| Platform | Steps |
| --- | --- |
| macOS (menu-bar app) | `launchctl setenv OLLAMA_ORIGINS "https://medmorf.com"`, then quit Ollama from the menu bar and reopen it. Not reboot-persistent; use a LaunchAgent or a shell-profile `export` for permanence. |
| Linux (systemd) | `sudo systemctl edit ollama` → add `[Service]` / `Environment="OLLAMA_ORIGINS=https://medmorf.com"` → `sudo systemctl restart ollama`. |
| Windows | Add user environment variable `OLLAMA_ORIGINS` = `https://medmorf.com` in Settings, quit Ollama from the tray, start it again. |
| Any platform, temporary | `OLLAMA_ORIGINS=https://medmorf.com ollama serve` in a terminal. |

Running Medmorf from localhost (e.g. `node tools/dev-server-isolated.mjs` or a self-hosted copy) needs no configuration. Chrome additionally asks once whether medmorf.com may access devices on the local network; users must click **Allow** (a Block is remembered per site). Firefox has no such prompt; Safari's handling of https-to-localhost requests must be tested before release. Mixed-content rules are not an obstacle: browsers treat `http://localhost` as a trustworthy origin, and `COEP: credentialless` permits uncredentialed cross-origin fetches.

**Implementation order:** probe + setup card + Anonymize adapter first (validate the medmorf.com flow on a real Ollama install), then Summarize, then Benchmark. The same adapter covers LM Studio and llama.cpp's server if ever wanted (OpenAI-style endpoint, different port).

## Troubleshooting

The version of the code you are running is shown at the bottom of the page as "Version <date> · build <commit>" (also `window.MEDMORF_BUILD_ID` in the console). Deploys stamp it automatically with `tools/stamp-build.sh` (commit date + short sha), which also renames the service-worker cache and every `?v=` asset tag, so each release busts the app-shell cache without manual version bumps. Compare the footer with the latest commit on `main` to see whether a deploy has landed or your browser is holding an old app shell (Storage → force-refresh). A local checkout shows `dev-unstamped`.

- If a model download fails, check the network connection and anything blocking `huggingface.co`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `esm.sh`, Google Fonts, or `tessdata.projectnaptha.com`.
- If Chrome reports a `Cache.add()` failure while loading Qwen, clear the LLM/WebLLM cache from the Storage tab, hard refresh, keep the tab in the foreground, and retry.
- If a model crashes or hangs, choose a smaller model, use NER-only mode, close memory-heavy tabs, and keep Medmorf visible during long runs.
- If DICOM folder buttons are unavailable, use a Chromium browser with File System Access API support.
- If offline mode does not behave as expected locally, make sure the app is served over `http://localhost:8000/` rather than opened with `file://`.

## Contributing

Before changing code, read [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md). Any change that affects features, files, dependencies, privacy posture, local serving, service-worker cache versioning, or folder structure must update this README in the same change.
