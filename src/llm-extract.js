// llm-extract.js
// Streaming JSON entity extraction with a repetition guard, plus a parser that
// salvages complete objects from truncated output. Shared by the Anonymize
// pipeline (src/anonymize-handler.js) and the Benchmark tab
// (src/benchmark-handler.js). No DOM.
//
// Why: small Qwen models can fall into a loop on dialogue-style text, emitting
// the same {"entity":…} objects until max_tokens (measured 2026-09-10: ~60 s
// per chunk and a truncated array whose entities were all lost). Streaming lets
// us stop generation at the first repeated objects; the salvage parser keeps
// everything that was complete when output stopped for any reason.

const OBJECT_RE = /\{[^{}]*\}/g;

// Parse a model reply into [{ entity, type, … }]. Tries the whole array first;
// otherwise parses every complete top-level object individually.
export function parseEntityArray(raw) {
    const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    let entities = null;
    let truncated = false;
    if (start >= 0 && end > start) {
        try { const arr = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(arr)) entities = arr; } catch { /* fall through to salvage */ }
    }
    if (!entities) {
        entities = [];
        truncated = /\{/.test(text);
        for (const m of text.matchAll(OBJECT_RE)) {
            try { entities.push(JSON.parse(m[0])); } catch { /* skip broken object */ }
        }
    }
    return {
        entities: entities.filter(e => e && typeof e === 'object' && typeof e.entity === 'string' && e.entity.trim()),
        truncated,
    };
}

// Stream a chat completion and interrupt it as soon as the model starts
// repeating objects it already emitted (`maxRepeats` consecutive duplicates).
// Returns the raw text so far and whether a loop was cut.
export async function streamEntityExtraction(engine, messages, { max_tokens = 2048, temperature = 0, maxRepeats = 2, extra_body = { enable_thinking: false } } = {}) {
    const stream = await engine.chat.completions.create({ messages, stream: true, max_tokens, temperature, extra_body });
    let raw = '';
    let scanned = 0;
    let repeatsInRow = 0;
    let looped = false;
    const seen = new Set();
    let drained = 0;
    for await (const chunk of stream) {
        if (looped) {
            // Keep consuming until the generator ends on its own: breaking out
            // of the stream leaves WebLLM's request lock held and the next
            // request waits forever (measured 2026-09-10). The interrupt makes
            // the generator finish within a few tokens.
            if (++drained > 64) break;
            continue;
        }
        const delta = chunk?.choices?.[0]?.delta?.content || '';
        if (!delta) continue;
        raw += delta;
        OBJECT_RE.lastIndex = scanned;
        let m;
        while ((m = OBJECT_RE.exec(raw)) !== null) {
            scanned = OBJECT_RE.lastIndex;
            const key = m[0].replace(/\s+/g, '').toLowerCase();
            if (seen.has(key)) {
                repeatsInRow++;
                if (repeatsInRow >= maxRepeats) { looped = true; break; }
            } else {
                seen.add(key);
                repeatsInRow = 0;
            }
        }
        if (looped) {
            try { engine.interruptGenerate(); } catch { /* engine may already be idle */ }
        }
    }
    OBJECT_RE.lastIndex = 0;
    return { raw, looped };
}
