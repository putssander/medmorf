// Private, bounded source snippets used only by explicitly requested local inference.
import { planIssues } from './data-column-plan.js?v=dev-unstamped';
import { configureModelExamples } from './data-synthetic-preview.js?v=dev-unstamped';
let contentSamples = new WeakMap();
export function registerContentSamples(column, values) {
    // Slice before filtering: missing cells must not pull samples from later rows.
    const samples = values.slice(0, 5).filter(v => v != null && String(v).trim() !== '').map(v => String(v).slice(0, 120));
    contentSamples.set(column, samples);
}
export function getContentSamples(column) { return [...(contentSamples.get(column) || [])]; }
export function clearContentSamples() { contentSamples = new WeakMap(); }
export function canDraft(target, key) {
    return !target[key]?.trim() || (target.aiDraftValues?.[key] !== undefined && target[key] === target.aiDraftValues[key]);
}
export function setDraft(target, key, value) {
    if (!canDraft(target, key) || !value) return false;
    target[key] = value;
    target.aiDraftValues = { ...target.aiDraftValues, [key]: value };
    target.aiDraft = true;
    return true;
}

export function columnEvidence(header, strings) {
    const words = header.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const idHeader = /\b(id|identifier|uuid|guid|key|identificatie|identificatienummer|recordnummer|patientnummer)\b/.test(words);
    const referenceHeader = /\b(foreign|reference|ref|parent)\b/.test(words) && idHeader;
    const unique = new Set(strings).size;
    const masks = new Map();
    for (const value of strings) {
        if (value.length > 64 || !/^[A-Za-z0-9._/-]+$/.test(value)) continue;
        const mask = value.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9');
        masks.set(mask, (masks.get(mask) || 0) + 1);
    }
    const common = [...masks].sort((a, b) => b[1] - a[1])[0];
    const format = common && common[1] / strings.length >= .8 ? common[0] : '';
    const dateLike = strings.length > 0 && strings.every(v => /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(v));
    return {
        nonMissing: strings.length, distinct: unique, uniqueFraction: strings.length ? unique / strings.length : 0,
        leadingZeros: strings.some(v => /^0\d+/.test(v)),
        nameSuggestsIdentifier: idHeader, nameSuggestsReference: referenceHeader,
        candidateRole: referenceHeader ? 'reference' : idHeader ? 'identifier' : dateLike ? 'datetime' : 'unknown',
        dominantCharacterFormat: format,
        formatCoverage: common && strings.length ? common[1] / strings.length : 0,
        caution: 'Hints, not validated meaning. Unique values alone do not make an ID. A letter/digit mask does not implement UUID/date/checksum constraints or establish foreign-key links.',
    };
}
const ROLES = new Set(['identifier', 'reference', 'measurement', 'category', 'boolean', 'datetime', 'free_text', 'unknown']);

// Accept only bounded, expected draft fields. Model output never controls export switches.
export function parseDraftJSON(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('Missing or oversized response');
    let clean = text.trim();
    // Some runtimes retain a reasoning prefix even when thinking is disabled.
    // Discard only a completed leading reasoning block; never treat its JSON as the answer.
    if (clean.startsWith('<think>')) {
        const end = clean.indexOf('</think>');
        if (end < 0) throw new Error('Unfinished reasoning wrapper');
        clean = clean.slice(end + 8).trim();
    } else if (clean.startsWith('</think>')) clean = clean.slice(8).trim();
    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const objectOnly = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
        return value;
    };
    try { return objectOnly(JSON.parse(clean)); } catch { /* Extract one complete object, never repair truncated JSON. */ }
    if (/^[\["0-9-]|^(null|true|false)\b/.test(clean)) throw new Error('Expected a JSON object');
    const start = clean.indexOf('{');
    if (start < 0) throw new Error('No JSON object');
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < clean.length; i++) {
        const char = clean[i];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
            if (clean.slice(i + 1).includes('{')) throw new Error('Ambiguous multiple JSON objects');
            return objectOnly(JSON.parse(clean.slice(start, i + 1)));
        }
    }
    throw new Error('Incomplete JSON object');
}
export function draftResponseDiagnostics(reply) {
    const choice = reply?.choices?.[0], content = choice?.message?.content;
    const text = typeof content === 'string' ? content : '';
    let parseable = false;
    try { parseDraftJSON(text); parseable = true; } catch { /* Metadata only. */ }
    return {
        contentType: content === null ? 'null' : typeof content,
        characters: text.length,
        finish: ['stop', 'length', 'abort', 'tool_calls'].includes(choice?.finish_reason) ? choice.finish_reason : 'unspecified',
        reasoningWrapper: /^\s*<\/?think>/.test(text),
        codeFence: /```/.test(text),
        parseableObject: parseable,
        outputTokens: Number.isFinite(reply?.usage?.completion_tokens) ? reply.usage.completion_tokens : null,
        grammarReported: Number.isFinite(reply?.usage?.extra?.grammar_init_s),
    };
}
const draftText = value => typeof value === 'string' ? value.trim().slice(0, 1500) : '';
export function applyColumnDrafts(table, draft, configureIdentifier) {
    if (!Array.isArray(draft.columns)) return 0;
    let filled = 0;
    for (const c of table.columns) {
        const item = draft.columns.find(item => item && item.alias === c.alias);
        if (!item) continue;
        if (ROLES.has(item.semanticRole) && setDraft(c, 'semanticRole', item.semanticRole)) filled++;
        for (const key of ['description', 'units', 'rules', 'harmonization']) {
            const value = draftText(item[key]);
            if (setDraft(c, key, value)) filled++;
        }
        const isID = ['identifier', 'reference'].includes(c.semanticRole);
        if (c.semanticRole && !isID && c.identifierFormat && c.identifierFormat === c.aiDraftValues?.identifierFormat) {
            configureIdentifier(c, ''); delete c.aiDraftValues.identifierFormat; table.sharePreview = false;
        }
        const mask = (isID || !c.semanticRole) ? draftText(item.identifierFormat) || (isID ? c.evidence?.dominantCharacterFormat || 'AA-999999' : '') : '';
        if (canDraft(c, 'identifierFormat') && mask && mask.length <= 64) {
            const previous = c.identifierFormat || '';
            configureIdentifier(c, mask);
            if (c.identifierIssue) configureIdentifier(c, previous);
            else { c.aiDraftValues = { ...c.aiDraftValues, identifierFormat: mask }; c.aiDraft = true; filled++; table.sharePreview = false; }
        }
        if (Array.isArray(item.syntheticExamples)) { configureModelExamples(c, item.syntheticExamples); table.sharePreview = false; }
    }
    return filled;
}
export function applyFileDraft(file, draft) {
    const value = draftText(draft.description);
    if (setDraft(file, 'description', value)) return 1;
    return 0;
}
export function briefDraft(draft) {
    const result = { purpose: draftText(draft.purpose), relationships: draftText(draft.relationships) };
    const count = Number(draft.count);
    if (Number.isSafeInteger(count) && count > 0 && count <= 1000000) result.count = String(count);
    if (['CSV', 'JSON', 'Python generator producing CSV'].includes(draft.format)) result.format = draft.format;
    return result;
}

export function draftGaps(tables, files, brief) {
    const missing = [];
    for (const file of files) if (!file.description?.trim()) missing.push(`${file.alias}: file description`);
    for (const [i, table] of tables.entries()) for (const c of table.columns) {
        for (const key of ['description', 'units', 'rules']) if (!c[key]?.trim()) missing.push(`table_${i + 1}.${c.alias}: ${key}`);
        if (!ROLES.has(c.semanticRole)) missing.push(`table_${i + 1}.${c.alias}: role`);
        if (['identifier', 'reference'].includes(c.semanticRole) && (!c.identifierFormat || c.identifierIssue)) missing.push(`table_${i + 1}.${c.alias}: valid ID format`);
    }
    const checked = briefDraft(brief);
    for (const key of ['purpose', 'relationships', 'count', 'format']) if (!checked[key]) missing.push(`generation brief: ${key}`);
    return missing;
}
export function draftResponseIssues(draft, payload) {
    if (payload.planColumns) return planIssues(draft, payload.planColumns);
    const issues = [];
    if (payload.file && !draftText(draft.description)) issues.push('file.description');
    if (Array.isArray(payload.columns)) for (const c of payload.columns) {
        const item = Array.isArray(draft.columns) && draft.columns.find(item => item?.alias === c.alias);
        if (!item) { issues.push(`${c.alias}: missing column`); continue; }
        if (!ROLES.has(item.semanticRole)) issues.push(`${c.alias}.semanticRole`);
        for (const key of ['description', 'units', 'rules']) if (!draftText(item[key])) issues.push(`${c.alias}.${key}`);
        if (payload.requireExamples && (!Array.isArray(item.syntheticExamples) || item.syntheticExamples.length !== 3 || item.syntheticExamples.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) issues.push(`${c.alias}.syntheticExamples`);
    }
    if (payload.currentBrief) for (const key of ['purpose', 'relationships', 'count', 'format']) if (!briefDraft(draft)[key]) issues.push(`brief.${key}`);
    return issues;
}
export function mergeDraftResponse(previous, incoming, payload) {
    if (payload.planColumns) return { groups: incoming.groups };
    if (Array.isArray(payload.columns)) return { columns: payload.columns.map(c => {
        const before = previous.columns?.find(item => item?.alias === c.alias) || {};
        const after = Array.isArray(incoming.columns) && incoming.columns.find(item => item?.alias === c.alias) || {};
        const result = { alias: c.alias };
        for (const key of ['description', 'units', 'rules', 'identifierFormat']) result[key] = draftText(before[key]) || draftText(after[key]);
        if (Array.isArray(after.syntheticExamples)) result.syntheticExamples = after.syntheticExamples;
        else if (Array.isArray(before.syntheticExamples)) result.syntheticExamples = before.syntheticExamples;
        const harmonization = draftText(before.harmonization) || draftText(after.harmonization);
        if (harmonization) result.harmonization = harmonization;
        result.semanticRole = ROLES.has(before.semanticRole) ? before.semanticRole : ROLES.has(after.semanticRole) ? after.semanticRole : '';
        return result;
    }) };
    if (payload.file) return { description: draftText(previous.description) || draftText(incoming.description) };
    const before = briefDraft(previous), after = briefDraft(incoming), result = {};
    for (const key of ['purpose', 'relationships', 'count', 'format']) result[key] = before[key] || after[key];
    return result;
}
export function validateDraftResponse(draft, payload) {
    const issues = draftResponseIssues(draft, payload);
    if (issues.length) throw new Error(`${payload.planColumns ? 'Invalid column analysis plan' : payload.file ? 'Missing file description' : payload.columns ? 'Missing column draft fields' : 'Incomplete generation brief'}: ${issues.join(', ')}`);
    return draft;
}

// WebLLM 0.2.83 supports schema-constrained JSON through response_format.
export function draftResponseFormat(payload) {
    const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
    const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    let schema;
    if (payload.planColumns) schema = object({ groups: { type: 'array', minItems: 1, maxItems: payload.planColumns.length, items: object({ columns: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: payload.planColumns.map(c => c.alias) } }, reason: text(240) }) } });
    else if (payload.file) schema = object({ description: text(320) });
    else if (Array.isArray(payload.columns)) schema = object({ columns: {
        type: 'array', minItems: payload.columns.length, maxItems: payload.columns.length,
        items: object({
            alias: { type: 'string', enum: payload.columns.map(c => c.alias) },
            semanticRole: { type: 'string', enum: [...ROLES] },
            description: text(160), units: text(60), rules: text(160), syntheticExamples: { type: 'array', minItems: 3, maxItems: 3, items: { anyOf: [{ type: 'string', maxLength: 120 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } }, identifierFormat: { type: 'string', maxLength: 64 }, harmonization: { type: 'string', maxLength: 160 },
        }),
    } });
    else schema = object({ purpose: text(400), relationships: text(480), count: { type: 'integer', minimum: 1, maximum: 1000000 }, format: { type: 'string', enum: ['CSV', 'JSON', 'Python generator producing CSV'] } });
    return { type: 'json_object', schema: JSON.stringify(schema) };
}

export async function runDraftInference(engine, request, options = {}) {
    // Larger JSON schemas need more time. Keep a separate no-progress limit so
    // increasing the task budget does not leave a stalled GPU running indefinitely.
    if (typeof options === 'number') options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? Math.min(300000, Math.max(120000, 90000 + (request.max_tokens || 900) * 100));
    const idleTimeoutMs = options.idleTimeoutMs ?? 90000;
    const started = Date.now();
    let timer, idleTimer, stopTimer, finished = false, characters = 0;
    const progress = () => options.onProgress?.({ characters, elapsedMs: Date.now() - started, timeoutMs });
    try {
        let fail;
        const cancelled = new Promise((_, reject) => { fail = (code, reason, limitMs) => {
            if (finished) return;
            finished = true;
            try { engine.interruptGenerate(); } catch { /* Device may already be lost. */ }
            const message = code === 'DRAFT_OUTPUT_LIMIT' ? 'Local response exceeded the bounded output size' : code === 'DRAFT_CANCELLED' ? 'Analysis cancelled' : reason === 'idle'
                ? `no generation progress for ${Math.round(limitMs / 1000)} seconds; generation interrupted`
                : `task reached its ${Math.round(limitMs / 1000)}-second time budget; generation interrupted`;
            const error = new Error(message);
            Object.assign(error, { code, reason, limitMs, characters });
            reject(error);
        }; });
        const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail('DRAFT_TIMEOUT', 'idle', idleTimeoutMs), idleTimeoutMs); };
        timer = setTimeout(() => fail('DRAFT_TIMEOUT', 'total', timeoutMs), timeoutMs);
        resetIdle();
        if (options.shouldStop) stopTimer = setInterval(() => { if (options.shouldStop()) fail('DRAFT_CANCELLED'); }, 100);
        progress();
        const generate = async () => {
            if (options.shouldStop?.()) { fail('DRAFT_CANCELLED'); return; }
            const response = await engine.chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } });
            // Also accept a completed response from an adapter/test engine.
            if (!response?.[Symbol.asyncIterator]) return response;
            let content = '', finish = null, usage, drained = 0;
            for await (const chunk of response) {
                // Interrupt then drain: immediately closing WebLLM's iterator can
                // leave its request lock held. A failed run never starts another task.
                if (finished) { if (++drained > 64) break; continue; }
                if (options.shouldStop?.()) { fail('DRAFT_CANCELLED'); continue; }
                const delta = chunk?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length) {
                    characters += delta.length;
                    if (characters > 50000) { fail('DRAFT_OUTPUT_LIMIT', 'output'); continue; }
                    content += delta;
                    resetIdle();
                    progress(); // Counts only; never expose partial text in the UI.
                }
                finish = chunk?.choices?.[0]?.finish_reason || finish;
                if (chunk?.usage) usage = chunk.usage;
            }
            return { choices: [{ message: { content }, finish_reason: finish }], usage };
        };
        return await Promise.race([
            cancelled, generate(),
        ]);
    } finally { finished = true; clearTimeout(timer); clearTimeout(idleTimer); clearInterval(stopTimer); }
}
