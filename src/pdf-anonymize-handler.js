// pdf-anonymize-handler.js — Burn-in PDF redaction library, 100% in-browser.
//
// This is now a *helper module* used by the main Anonymize tab. It exposes
// `window.medmorfPdfBurnIn.redactPdf(file, targets, opts) → Blob`.
//
// The caller (anonymize-handler.js) is responsible for picking the entities to
// redact using its currently-selected pipeline (NER, LLM, or NER+LLM). We
// receive the list of original entity *strings* (the keys of `currentMapping`)
// and locate them on each page — no extra NER/LLM pass happens here, so the
// same model the user picked drives both the on-screen preview/mapping and
// the burn-in PDF output.
//
// Per page (auto-detected):
//   1. PDF.js: if the page has an extractable text layer, use text-item
//      bounding boxes; otherwise rasterize and run Tesseract.js OCR.
//   2. Search the reconstructed string for each target (case-insensitive
//      substring) → spans → rects via segment intersection.
//   3. Render to canvas, paint black over rects, embed as JPEG into a fresh
//      pdf-lib document. The output PDF is fully rasterized; the original
//      glyph stream is gone, so the underlying text really is removed.

(function () {
    'use strict';

    // ── Config ───────────────────────────────────────────────────────────
    const PDFJS_VERSION = '4.7.76';
    const TESSERACT_VERSION = '5.1.1';
    const MIN_TEXT_CHARS = 20;         // below this → treat page as scanned
    const REDACT_SCALE = 2.0;          // canvas DPI multiplier
    const REDACT_PADDING_PX = 2;
    const JPEG_QUALITY = 0.85;

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
            cacheMethod: 'write',
        });
        _ocrWorker = worker;
        _ocrWorkerLang = lang;
        return worker;
    }

    // ── Text-layer extraction with offset → rect map ─────────────────────
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
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]) || (item.height * viewport.scale);
            const widthPx = (item.width || 0) * viewport.scale || (fontHeight * str.length * 0.5);
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
            if (item.hasEOL) joined += '\n';
            else joined += ' ';
        }

        return { joined, segments };
    }

    function spanToRects(span, segments) {
        const rects = [];
        for (const seg of segments) {
            if (seg.end <= span.start || seg.start >= span.end) continue;
            const segLen = Math.max(1, seg.end - seg.start);
            const lo = Math.max(span.start, seg.start) - seg.start;
            const hi = Math.min(span.end, seg.end) - seg.start;
            const x = seg.rect.x + (lo / segLen) * seg.rect.w;
            const w = ((hi - lo) / segLen) * seg.rect.w;
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
        for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
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

    // ── Auto language detection (for OCR) ────────────────────────────────
    const TESS_LANGS = {
        eng: ['the','is','and','of','to','in','that','for','with','was','on','are','this','but','not','from','have','has','had','been','were','they','will','can','about','which','their','said'],
        nld: ['de','het','een','van','en','is','dat','voor','niet','met','op','aan','uit','maar','ook','naar','als','nog','wordt','zijn','heeft','deze','dit','bij','kan','over','werd','door'],
        deu: ['der','die','das','und','ist','nicht','mit','für','von','den','dem','sich','auf','auch','ein','eine','sind','wird','wurde','aber','noch','sein','haben','hat','beim','durch'],
        fra: ['le','la','les','de','des','et','est','un','une','pour','dans','avec','que','qui','sur','ne','pas','par','plus','au','aux','ce','cette','son','sa','ses','mais','ou','où'],
        spa: ['el','la','los','las','de','y','que','en','un','una','por','con','no','para','es','se','su','sus','del','al','como','más','pero','también','este','esta','sobre'],
    };
    function detectTesseractLang(text) {
        if (!text || text.length < 40) return null;
        const sample = text.substring(0, 4000).toLowerCase();
        const scores = {};
        for (const code of Object.keys(TESS_LANGS)) {
            let s = 0;
            for (const w of TESS_LANGS[code]) {
                const re = new RegExp('\\b' + w + '\\b', 'g');
                s += (sample.match(re) || []).length;
            }
            scores[code] = s;
        }
        let best = 'eng', bestScore = scores.eng;
        for (const code of Object.keys(scores)) {
            if (scores[code] > bestScore) { best = code; bestScore = scores[code]; }
        }
        if (best !== 'eng' && scores[best] < scores.eng * 1.3) return 'eng';
        if (bestScore < 3) return null;
        return best;
    }

    // ── Target-string → spans ────────────────────────────────────────────
    // Find every case-insensitive occurrence of `target` in `joined`.
    // Returns [{ start, end }] in `joined` offsets.
    function findSpans(joined, target) {
        const spans = [];
        if (!target) return spans;
        const t = target.trim();
        if (t.length < 2) return spans;
        const hay = joined.toLowerCase();
        const needle = t.toLowerCase();
        let from = 0;
        while (from <= hay.length - needle.length) {
            const idx = hay.indexOf(needle, from);
            if (idx === -1) break;
            spans.push({ start: idx, end: idx + needle.length });
            from = idx + needle.length;
        }
        return spans;
    }

    // ── Public API: redactPdf ────────────────────────────────────────────
    /**
     * @param {File|Blob} file       The PDF to redact.
     * @param {string[]}  targets    Entity strings (original text) to burn over.
     * @param {object}    [opts]
     * @param {(pct:number, msg?:string) => void} [opts.onProgress]
     * @returns {Promise<{ blob: Blob, summary: object }>}
     */
    async function redactPdf(file, targets, opts) {
        opts = opts || {};
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
        if (!file) throw new Error('No file provided.');
        if (typeof PDFLib === 'undefined' || !PDFLib.PDFDocument) {
            throw new Error('PDF library (pdf-lib) failed to load.');
        }

        // De-duplicate and sort targets longest-first so longer matches win.
        const uniqTargets = Array.from(new Set((targets || [])
            .filter(t => typeof t === 'string' && t.trim().length >= 2)))
            .sort((a, b) => b.length - a.length);

        const summary = {
            pages: 0,
            textPages: 0,
            ocrPages: 0,
            targets: uniqTargets.length,
            hits: 0,
            ocrLang: null,
        };

        onProgress(0, 'Loading PDF…');
        const pdfjs = await loadPdfjs();
        const bytes = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        const numPages = pdf.numPages;
        summary.pages = numPages;

        let ocrLang = 'eng';
        let ocrLangLocked = false;
        const outDoc = await PDFLib.PDFDocument.create();

        for (let i = 1; i <= numPages; i++) {
            const pageBase = 5 + ((i - 1) / numPages) * 90;
            onProgress(pageBase, `Page ${i} of ${numPages}: reading…`);

            const page = await pdf.getPage(i);
            const baseViewport = page.getViewport({ scale: 1 });
            const probeViewport = page.getViewport({ scale: REDACT_SCALE });

            // 1) Text layer first
            let { joined, segments } = await extractTextLayerSegments(page, pdfjs, probeViewport);
            let usedOcr = false;
            if (joined.trim().length < MIN_TEXT_CHARS) {
                usedOcr = true;
                onProgress(pageBase + 2, `Page ${i} of ${numPages}: no text layer — OCR…`);
            }

            // 2) Render to canvas (always — needed for burn-in output)
            const { canvas, ctx } = await renderPageToCanvas(page, REDACT_SCALE);

            // 3) OCR if needed (with auto language detection on first OCR page)
            if (usedOcr) {
                let ocr = await ocrSegments(canvas, ocrLang);
                if (!ocrLangLocked) {
                    ocrLangLocked = true;
                    const detected = detectTesseractLang(ocr.joined);
                    if (detected && detected !== ocrLang) {
                        onProgress(pageBase + 6, `Page ${i}: detected ${detected.toUpperCase()} — re-OCR…`);
                        ocrLang = detected;
                        ocr = await ocrSegments(canvas, ocrLang);
                    }
                    summary.ocrLang = ocrLang;
                }
                joined = ocr.joined;
                segments = ocr.segments;
                summary.ocrPages++;
            } else {
                summary.textPages++;
            }

            // 4) Locate every target string → rects, then burn black
            onProgress(pageBase + 10, `Page ${i} of ${numPages}: redacting…`);
            const allRects = [];
            for (const target of uniqTargets) {
                const spans = findSpans(joined, target);
                for (const span of spans) {
                    summary.hits++;
                    const rects = spanToRects(span, segments);
                    for (const r of rects) allRects.push(r);
                }
            }
            if (allRects.length) paintRedactions(ctx, allRects);

            // 5) Embed page
            const jpegBytes = await canvasToJpegBytes(canvas, JPEG_QUALITY);
            const img = await outDoc.embedJpg(jpegBytes);
            const outPage = outDoc.addPage([baseViewport.width, baseViewport.height]);
            outPage.drawImage(img, {
                x: 0, y: 0,
                width: baseViewport.width,
                height: baseViewport.height,
            });

            page.cleanup();
        }

        onProgress(98, 'Saving redacted PDF…');
        const outBytes = await outDoc.save();
        const blob = new Blob([outBytes], { type: 'application/pdf' });
        onProgress(100, 'Done.');
        return { blob, summary };
    }

    function isAvailable() {
        return typeof PDFLib !== 'undefined' && !!PDFLib.PDFDocument;
    }

    window.medmorfPdfBurnIn = { redactPdf, isAvailable };
    console.log('[PDF-BURNIN] library ready');
})();
