// pdf-anonymize-handler.js — Real, burned-in PDF redaction, 100% in-browser.
//
// Pipeline per page (auto-detected):
//   1. PDF.js parses the page. If it has a text layer (>= MIN_TEXT_CHARS of
//      extractable text), use text-item bounding boxes. Otherwise run OCR via
//      Tesseract.js against the rasterized page (always-on auto-OCR for scans).
//   2. The reconstructed text is sent through Medmorf's existing NER pipeline
//      (privacy-runtime.js). Entities returned as character offsets are mapped
//      back to per-word / per-text-item bounding boxes in canvas pixel space.
//   3. The page is rendered to a canvas at REDACT_SCALE; black rectangles are
//      painted over each PII bounding box (with small padding); the canvas is
//      embedded as a JPEG page into a freshly-created PDF via pdf-lib.
//
// The output PDF contains rasterized pages only — the original glyph stream
// and any image-embedded text are gone. This is the only way to be sure the
// underlying PII data is removed (overlay-only redaction is insecure).

import {
    initNERPipeline,
    getNERPipeline,
    getGLiNERInstance,
    isGLiNERModel,
    getActiveNERModelId,
    DEFAULT_NER_MODEL_ID,
} from './privacy-runtime.js';

(function () {
    'use strict';

    // ── Config ───────────────────────────────────────────────────────────
    const PDFJS_VERSION = '4.7.76';
    const TESSERACT_VERSION = '5.1.1';
    const MIN_TEXT_CHARS = 20;         // below this → treat page as scanned
    const REDACT_SCALE = 2.0;          // canvas DPI multiplier
    const REDACT_PADDING_PX = 2;
    const JPEG_QUALITY = 0.85;
    const GLINER_LABELS = [
        'person', 'name', 'organization', 'location', 'address',
        'phone number', 'email', 'date', 'date of birth',
        'social security number', 'identification number',
        'medical record number', 'patient id',
    ];

    // ── DOM ──────────────────────────────────────────────────────────────
    const dropArea = document.getElementById('pdfanonDrop');
    const fileInput = document.getElementById('pdfanonInput');
    const runBtn = document.getElementById('pdfanonRunBtn');
    const clearBtn = document.getElementById('pdfanonClearBtn');
    const fileInfoEl = document.getElementById('pdfanonFileInfo');
    const ocrLangSelect = document.getElementById('pdfanonOcrLang');
    const statusEl = document.getElementById('pdfanonStatus');
    const progressBar = document.getElementById('pdfanonProgressBar');
    const progressWrap = document.getElementById('pdfanonProgress');
    const reportEl = document.getElementById('pdfanonReport');

    if (!dropArea || !fileInput || !runBtn) {
        // Tab markup not present — nothing to do.
        return;
    }

    let selectedFile = null;
    let isRunning = false;

    // ── Status helpers ───────────────────────────────────────────────────
    function setStatus(message, type) {
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.className = 'mergepdf-status' + (type ? ' is-' + type : '');
    }
    function setProgress(pct, text) {
        if (progressWrap) progressWrap.style.display = 'block';
        if (progressBar) progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (text) setStatus(text, 'progress');
    }
    function hideProgress() {
        if (progressWrap) progressWrap.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
    }
    function humanSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── File selection ───────────────────────────────────────────────────
    function setFile(file) {
        selectedFile = file || null;
        if (selectedFile) {
            fileInfoEl.textContent = `${selectedFile.name} (${humanSize(selectedFile.size)})`;
            fileInfoEl.style.display = '';
            runBtn.disabled = false;
        } else {
            fileInfoEl.textContent = '';
            fileInfoEl.style.display = 'none';
            runBtn.disabled = true;
        }
        if (reportEl) reportEl.innerHTML = '';
        setStatus('', '');
        hideProgress();
    }
    function accept(fileList) {
        for (const f of fileList) {
            const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
            if (isPdf) { setFile(f); return; }
        }
        setStatus('Only PDF files are supported.', 'error');
    }
    dropArea.addEventListener('click', () => fileInput.click());
    dropArea.tabIndex = 0;
    dropArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', (e) => {
        accept(e.target.files);
        fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(evt => dropArea.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropArea.classList.add('is-dragover');
    }));
    ['dragleave', 'drop'].forEach(evt => dropArea.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropArea.classList.remove('is-dragover');
    }));
    dropArea.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files) accept(e.dataTransfer.files);
    });
    if (clearBtn) clearBtn.addEventListener('click', () => setFile(null));

    // ── Lazy CDN loaders ─────────────────────────────────────────────────
    let _pdfjsLib = null;
    async function loadPdfjs() {
        if (_pdfjsLib) return _pdfjsLib;
        const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`);
        if (lib.GlobalWorkerOptions) {
            lib.GlobalWorkerOptions.workerSrc =
                `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
        }
        _pdfjsLib = lib;
        return lib;
    }

    let _tesseractPromise = null;
    function loadTesseract() {
        if (typeof Tesseract !== 'undefined') return Promise.resolve(window.Tesseract);
        if (_tesseractPromise) return _tesseractPromise;
        _tesseractPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
            s.onload = () => resolve(window.Tesseract);
            s.onerror = () => reject(new Error('Failed to load Tesseract.js'));
            document.head.appendChild(s);
        });
        return _tesseractPromise;
    }

    let _ocrWorker = null;
    let _ocrWorkerLang = null;
    async function getOcrWorker(lang) {
        const Tesseract = await loadTesseract();
        if (_ocrWorker && _ocrWorkerLang === lang) return _ocrWorker;
        if (_ocrWorker) {
            try { await _ocrWorker.terminate(); } catch {}
            _ocrWorker = null;
        }
        const worker = await Tesseract.createWorker(lang, 1, {
            logger: () => {},
            // Cache traineddata via Cache Storage so the service-worker can persist it
            cacheMethod: 'write',
        });
        _ocrWorker = worker;
        _ocrWorkerLang = lang;
        return worker;
    }

    // ── NER ──────────────────────────────────────────────────────────────
    async function ensureNERLoaded() {
        if (getNERPipeline() || getGLiNERInstance()) return;
        setProgress(2, 'Loading NER model (first time only)…');
        await initNERPipeline({
            modelId: getActiveNERModelId() || DEFAULT_NER_MODEL_ID,
            progressCallback: (p) => {
                if (p && typeof p.progress === 'number') {
                    setProgress(2 + p.progress * 8, `Loading NER model… ${Math.round(p.progress * 100)}%`);
                }
            },
        });
    }

    /**
     * Run NER on a text string and return entities with char-offset spans.
     * Returns: [{ start, end, text, label, score }]
     */
    async function detectEntities(text) {
        if (!text || !text.trim()) return [];
        const modelId = getActiveNERModelId() || DEFAULT_NER_MODEL_ID;

        if (isGLiNERModel(modelId)) {
            const gliner = getGLiNERInstance();
            if (!gliner) return [];
            const results = await gliner.inference({
                texts: [text],
                entities: GLINER_LABELS,
                threshold: 0.45,
            });
            const out = [];
            const arr = (results && results[0]) || [];
            for (const r of arr) {
                if (typeof r.start !== 'number' || typeof r.end !== 'number') continue;
                out.push({
                    start: r.start,
                    end: r.end,
                    text: r.spanText || text.slice(r.start, r.end),
                    label: (r.label || 'PII').toUpperCase(),
                    score: r.score || 0,
                });
            }
            return out;
        }

        // Generic Transformers.js token-classification path
        const pipeline = getNERPipeline();
        if (!pipeline) return [];
        const aggregated = await pipeline(text, { aggregation_strategy: 'simple' });
        const out = [];
        for (const r of aggregated) {
            if (typeof r.start !== 'number' || typeof r.end !== 'number') continue;
            out.push({
                start: r.start,
                end: r.end,
                text: r.word || text.slice(r.start, r.end),
                label: String(r.entity_group || r.entity || 'PII').toUpperCase(),
                score: r.score || 0,
            });
        }
        return out;
    }

    // ── Text-layer extraction with offset → rect map ─────────────────────
    /**
     * Extract text from a PDF page and produce:
     *   - joined: the concatenated string sent to NER
     *   - segments: [{ start, end, rect: {x,y,w,h} }] in canvas px (top-left origin)
     */
    async function extractTextLayerSegments(page, pdfjs, viewport) {
        const tc = await page.getTextContent();
        const segments = [];
        let joined = '';

        for (const item of tc.items) {
            if (!item || typeof item.str !== 'string') continue;
            const str = item.str;
            if (str.length === 0) {
                if (item.hasEOL) joined += '\n';
                continue;
            }
            // Effective transform = viewport * item.transform
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]) || (item.height * viewport.scale);
            // Approximate width in canvas px — pdfjs reports `width` in text units
            const widthPx = item.width * viewport.scale;
            // tx[4], tx[5] is the baseline origin (canvas coords, top-left after viewport)
            const x = tx[4];
            const yTop = tx[5] - fontHeight;
            const segStart = joined.length;
            joined += str;
            const segEnd = joined.length;
            segments.push({
                start: segStart,
                end: segEnd,
                rect: { x, y: yTop, w: widthPx, h: fontHeight },
            });
            // Insert a space between non-adjacent runs so NER tokenises correctly
            if (item.hasEOL) joined += '\n';
            else joined += ' ';
        }

        return { joined, segments };
    }

    /**
     * For an entity span [start,end), return one or more canvas rects by
     * intersecting with text-layer segments. For partial overlaps we narrow
     * the rect proportionally by character index within the segment.
     */
    function spanToRects(span, segments) {
        const rects = [];
        for (const seg of segments) {
            if (seg.end <= span.start || seg.start >= span.end) continue;
            const segLen = Math.max(1, seg.end - seg.start);
            const charsPerPx = segLen / seg.rect.w;
            const lo = Math.max(span.start, seg.start) - seg.start;
            const hi = Math.min(span.end, seg.end) - seg.start;
            const x = seg.rect.x + (lo / segLen) * seg.rect.w;
            const w = ((hi - lo) / segLen) * seg.rect.w;
            // ignore charsPerPx — informational only
            void charsPerPx;
            rects.push({
                x: x - REDACT_PADDING_PX,
                y: seg.rect.y - REDACT_PADDING_PX,
                w: w + 2 * REDACT_PADDING_PX,
                h: seg.rect.h + 2 * REDACT_PADDING_PX,
            });
        }
        return rects;
    }

    // ── OCR path: words with bboxes in canvas px ─────────────────────────
    /**
     * Run OCR on a canvas. Returns:
     *   - joined: text built by concatenating words with single spaces / newlines
     *   - segments: [{ start, end, rect }] in canvas px (top-left origin)
     */
    async function ocrSegments(canvas, lang) {
        const worker = await getOcrWorker(lang);
        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
        const segments = [];
        let joined = '';

        const walkLines = (lines) => {
            for (const line of (lines || [])) {
                const words = line.words || [];
                for (let i = 0; i < words.length; i++) {
                    const w = words[i];
                    const txt = (w.text || '').trim();
                    if (!txt) continue;
                    const segStart = joined.length;
                    joined += txt;
                    const segEnd = joined.length;
                    const bb = w.bbox || {};
                    segments.push({
                        start: segStart,
                        end: segEnd,
                        rect: {
                            x: bb.x0 || 0,
                            y: bb.y0 || 0,
                            w: Math.max(1, (bb.x1 || 0) - (bb.x0 || 0)),
                            h: Math.max(1, (bb.y1 || 0) - (bb.y0 || 0)),
                        },
                    });
                    joined += (i === words.length - 1) ? '\n' : ' ';
                }
            }
        };

        if (data.blocks && data.blocks.length) {
            for (const block of data.blocks) {
                for (const para of (block.paragraphs || [])) walkLines(para.lines);
            }
        } else if (data.lines && data.lines.length) {
            walkLines(data.lines);
        } else if (data.words && data.words.length) {
            // Fallback flat words list
            for (const w of data.words) {
                const txt = (w.text || '').trim();
                if (!txt) continue;
                const segStart = joined.length;
                joined += txt;
                const segEnd = joined.length;
                const bb = w.bbox || {};
                segments.push({
                    start: segStart,
                    end: segEnd,
                    rect: {
                        x: bb.x0 || 0,
                        y: bb.y0 || 0,
                        w: Math.max(1, (bb.x1 || 0) - (bb.x0 || 0)),
                        h: Math.max(1, (bb.y1 || 0) - (bb.y0 || 0)),
                    },
                });
                joined += ' ';
            }
        }

        return { joined, segments };
    }

    // ── Page rendering ───────────────────────────────────────────────────
    async function renderPageToCanvas(page, scale) {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: false });
        await page.render({ canvasContext: ctx, viewport }).promise;
        return { canvas, ctx, viewport };
    }

    function paintRedactions(ctx, rects) {
        ctx.save();
        ctx.fillStyle = '#000';
        for (const r of rects) {
            ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.restore();
    }

    function canvasToJpegBytes(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(async (blob) => {
                if (!blob) return reject(new Error('Canvas toBlob failed'));
                const buf = await blob.arrayBuffer();
                resolve(new Uint8Array(buf));
            }, 'image/jpeg', quality);
        });
    }

    // ── Main run ─────────────────────────────────────────────────────────
    async function run() {
        if (!selectedFile || isRunning) return;
        if (typeof PDFLib === 'undefined' || !PDFLib.PDFDocument) {
            setStatus('PDF library failed to load. Reload the page and try again.', 'error');
            return;
        }
        isRunning = true;
        runBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
        if (reportEl) reportEl.innerHTML = '';

        const ocrLang = (ocrLangSelect && ocrLangSelect.value) || 'eng';
        const summary = {
            pages: 0,
            textPages: 0,
            ocrPages: 0,
            entities: 0,
            byLabel: {},
        };

        try {
            setProgress(0, 'Loading PDF…');
            const pdfjs = await loadPdfjs();
            const bytes = await selectedFile.arrayBuffer();
            const pdf = await pdfjs.getDocument({ data: bytes }).promise;
            const numPages = pdf.numPages;
            summary.pages = numPages;

            await ensureNERLoaded();

            const outDoc = await PDFLib.PDFDocument.create();

            for (let i = 1; i <= numPages; i++) {
                const pageBaseProgress = 10 + ((i - 1) / numPages) * 85;
                setProgress(pageBaseProgress, `Page ${i} of ${numPages}: analysing…`);

                const page = await pdf.getPage(i);
                const baseViewport = page.getViewport({ scale: 1 });

                // 1) Try the text layer first
                const probeViewport = page.getViewport({ scale: REDACT_SCALE });
                let { joined, segments } = await extractTextLayerSegments(page, pdfjs, probeViewport);
                let usedOcr = false;

                // 2) Auto-fallback to OCR if the text layer is empty/tiny
                if (joined.trim().length < MIN_TEXT_CHARS) {
                    usedOcr = true;
                    setProgress(pageBaseProgress + 5, `Page ${i} of ${numPages}: no text layer — running OCR…`);
                }

                // Render page (we always need the canvas for burn-in)
                const { canvas, ctx } = await renderPageToCanvas(page, REDACT_SCALE);

                if (usedOcr) {
                    const ocr = await ocrSegments(canvas, ocrLang);
                    joined = ocr.joined;
                    segments = ocr.segments;
                    summary.ocrPages++;
                } else {
                    summary.textPages++;
                }

                // 3) NER
                setProgress(pageBaseProgress + 50 / numPages, `Page ${i} of ${numPages}: detecting PII…`);
                const entities = await detectEntities(joined);

                // 4) Map entities → rects and burn redactions
                const allRects = [];
                for (const e of entities) {
                    summary.entities++;
                    summary.byLabel[e.label] = (summary.byLabel[e.label] || 0) + 1;
                    const rects = spanToRects(e, segments);
                    for (const r of rects) allRects.push(r);
                }
                if (allRects.length) paintRedactions(ctx, allRects);

                // 5) Embed as image into the output PDF, preserving page size
                const jpegBytes = await canvasToJpegBytes(canvas, JPEG_QUALITY);
                const img = await outDoc.embedJpg(jpegBytes);
                const outPage = outDoc.addPage([baseViewport.width, baseViewport.height]);
                outPage.drawImage(img, {
                    x: 0, y: 0,
                    width: baseViewport.width,
                    height: baseViewport.height,
                });

                // Free per-page memory aggressively
                page.cleanup();
            }

            setProgress(98, 'Saving redacted PDF…');
            const outBytes = await outDoc.save();
            const blob = new Blob([outBytes], { type: 'application/pdf' });
            const outName = selectedFile.name.replace(/\.pdf$/i, '') + '.redacted.pdf';
            downloadBlob(blob, outName);

            setProgress(100, `Done — saved as "${outName}".`);
            renderReport(summary);
            setStatus(`Done — saved as "${outName}". ${summary.entities} entities redacted across ${summary.pages} page(s).`, 'success');
        } catch (err) {
            console.error('[PDF-ANON] failed:', err);
            setStatus((err && err.message) || 'PDF anonymization failed.', 'error');
        } finally {
            isRunning = false;
            runBtn.disabled = !selectedFile;
            if (clearBtn) clearBtn.disabled = false;
            setTimeout(hideProgress, 800);
        }
    }

    function renderReport(summary) {
        if (!reportEl) return;
        const labelRows = Object.entries(summary.byLabel)
            .sort((a, b) => b[1] - a[1])
            .map(([label, count]) => `<li><strong>${label}</strong>: ${count}</li>`)
            .join('');
        reportEl.innerHTML = `
            <h4 class="mergepdf-step">Redaction summary</h4>
            <ul class="pdfanon-summary">
                <li>Pages processed: <strong>${summary.pages}</strong> (text-layer: ${summary.textPages}, OCR: ${summary.ocrPages})</li>
                <li>Total entities redacted: <strong>${summary.entities}</strong></li>
            </ul>
            ${labelRows ? `<ul class="pdfanon-summary">${labelRows}</ul>` : ''}
            <p class="mergepdf-hint">The output PDF contains rasterized image pages — the original glyph and text data are gone. Always spot-check the result before sharing.</p>
        `;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    runBtn.addEventListener('click', run);

    console.log('[PDF-ANON] handler ready');
})();
