// text-chunking.js
// Paragraph-aware chunking with sentence-level overlap, shared by the
// Anonymize pipeline (src/anonymize-handler.js) and the Benchmark tab
// (src/benchmark-handler.js) so both split documents identically.
// Pure functions, no DOM.

export const DEFAULT_MAX_CHUNK_CHARS = 2400;
export const LOW_MEMORY_MAX_CHUNK_CHARS = 1600;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 240;
export const LOW_MEMORY_CHUNK_OVERLAP_CHARS = 160;

// ── Text Chunking ──────────────────────────────────────────────────────────────
export function getOverlapTail(text, overlapChars) {
    if (!overlapChars || text.length <= overlapChars) return '';
    const tail = text.slice(-overlapChars);
    const sentenceBreak = Math.max(
        tail.lastIndexOf('. '),
        tail.lastIndexOf('! '),
        tail.lastIndexOf('? '),
        tail.lastIndexOf('; ')
    );
    if (sentenceBreak > overlapChars * 0.35) return tail.slice(sentenceBreak + 1).trim();
    const lineBreak = tail.lastIndexOf('\n');
    if (lineBreak > overlapChars * 0.35) return tail.slice(lineBreak + 1).trim();
    const spaceBreak = tail.indexOf(' ');
    return (spaceBreak > 0 ? tail.slice(spaceBreak + 1) : tail).trim();
}

function splitLongTextSegment(segment, maxChars, overlapChars = 0) {
    const chunks = [];
    let remaining = segment.trim();
    while (remaining.length > maxChars) {
        const windowText = remaining.slice(0, maxChars + 1);
        const sentenceBreak = Math.max(
            windowText.lastIndexOf('. '),
            windowText.lastIndexOf('! '),
            windowText.lastIndexOf('? '),
            windowText.lastIndexOf('; ')
        );
        const lineBreak = windowText.lastIndexOf('\n');
        const spaceBreak = windowText.lastIndexOf(' ');
        let splitAt = Math.max(sentenceBreak > maxChars * 0.45 ? sentenceBreak + 1 : -1, lineBreak, spaceBreak);
        if (splitAt < maxChars * 0.35) splitAt = maxChars;
        chunks.push(remaining.slice(0, splitAt).trim());
        const effectiveOverlap = Math.min(overlapChars, Math.floor(maxChars * 0.2), Math.max(0, splitAt - 1));
        remaining = remaining.slice(Math.max(0, splitAt - effectiveOverlap)).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

export function chunkText(text, maxChars = DEFAULT_MAX_CHUNK_CHARS, overlapChars = DEFAULT_CHUNK_OVERLAP_CHARS) {
    const paragraphs = text.split(/\n+/);
    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
        if (!para.trim()) continue;
        if (para.length > maxChars) {
            if (current.trim()) {
                chunks.push(current.trim());
                current = '';
            }
            chunks.push(...splitLongTextSegment(para, maxChars, overlapChars));
            continue;
        }
        if ((current + '\n' + para).length > maxChars && current.length > 0) {
            const flushed = current.trim();
            chunks.push(flushed);
            const overlap = getOverlapTail(flushed, overlapChars);
            current = overlap ? `${overlap}\n${para}` : para;
        } else {
            current += (current ? '\n' : '') + para;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}
