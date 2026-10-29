// Comparison sets stay local in a private WeakMap so identifier formats can be changed after profiling.
const GENERIC = ['yes', 'no', 'unknown', 'pending', 'complete', 'active', 'inactive'];
const canonical = value => String(value).normalize('NFKC').trim().toLowerCase();
let identifierSources = new WeakMap();
let numericSources = new WeakMap();
export function registerIdentifierSource(column, strings) {
    identifierSources.set(column, new Set(strings.map(canonical)));
    if (column.type === 'number') numericSources.set(column, new Set(strings.map(Number)));
}
export function clearIdentifierSources() { identifierSources = new WeakMap(); numericSources = new WeakMap(); }

export function modelExampleIssue(column, values) {
    const fail = reason => `AI examples rejected: ${reason}`;
    const seen = identifierSources.get(column);
    if (!seen) return fail('source comparison data was cleared');
    if (!Array.isArray(values) || values.length !== 3) return fail('exactly three values are required');
    for (const value of values) {
        if (value === null) { if (column.missing || column.type === 'empty') continue; return fail('null was not observed'); }
        if (column.type === 'text' || column.identifierFormat) {
            if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 120) return fail('expected short text');
            // IDs use the separately validated format generator, rather than model guesses.
            if (column.identifierFormat) return '';
        } else if (column.type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < column.stats.min || value > column.stats.max || (column.numericKind === 'integer' && !Number.isSafeInteger(value))) return fail('number outside the observed type or range');
        } else if (column.type === 'boolean') { if (typeof value !== 'boolean') return fail('expected boolean'); }
        else return fail('expected an empty value');
        const exempt = column.type === 'boolean' || (column.type === 'number' && column.previewOptions?.exception?.startsWith('Binary')) || (column.allowGenericReuse && column.previewOptions?.genericValues?.includes(canonical(value)));
        if (!exempt && (column.type === 'number' ? numericSources.get(column)?.has(value) : seen.has(canonical(value)))) return fail('a proposed value occurs in the source column');
    }
    return '';
}
export function configureModelExamples(column, values) {
    delete column.modelExamples;
    column.exampleIssue = modelExampleIssue(column, values);
    if (!column.exampleIssue && !column.identifierFormat) column.modelExamples = [...values];
}

export function configureIdentifier(column, format) {
    delete column.modelExamples;
    column.exampleIssue = '';
    column.identifierFormat = format.trim();
    column.identifierValues = [];
    column.identifierIssue = '';
    if (!column.identifierFormat) return;
    const fail = message => { column.identifierIssue = message; };
    const seen = identifierSources.get(column);
    if (!seen) return fail('Source comparison data was cleared. Reselect the files.');
    if (column.identifierFormat.length > 64) return fail('Identifier format must be at most 64 characters.');
    const tokens = [], slots = { A: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', a: 'abcdefghijklmnopqrstuvwxyz', '9': '0123456789' };
    const mask = column.identifierFormat;
    for (let i = 0; i < mask.length; i++) {
        const char = mask[i];
        if (char === '\\') {
            if (++i >= mask.length || !/[A-Za-z0-9._/-]/.test(mask[i])) return fail('Escape must be followed by a literal letter, digit or separator.');
            tokens.push({ literal: mask[i] });
        } else if (slots[char]) tokens.push({ alphabet: slots[char] });
        else if (/[A-Za-z0-9._/-]/.test(char)) tokens.push({ literal: char });
        else return fail('Use A, a, 9 and literal letters, digits, hyphens, underscores, dots or slashes.');
    }
    if (!tokens.some(t => t.alphabet)) return fail('Include at least one A, a or 9 slot.');
    const size = tokens.reduce((n, t) => n * BigInt(t.alphabet?.length || 1), 1n);
    const limit = Number(size < 50000n ? size : 50000n);
    for (let candidateIndex = 0; candidateIndex < limit && column.identifierValues.length < 3; candidateIndex++) {
        let index = BigInt(candidateIndex);
        const chars = [];
        for (let i = tokens.length - 1; i >= 0; i--) {
            const token = tokens[i];
            if (token.literal !== undefined) chars.push(token.literal);
            else { const base = BigInt(token.alphabet.length); chars.push(token.alphabet[Number(index % base)]); index /= base; }
        }
        const candidate = chars.reverse().join('');
        if (!seen.has(canonical(candidate))) column.identifierValues.push(candidate);
    }
    if (column.identifierValues.length < 3) {
        column.identifierValues = [];
        fail(size <= 50000n ? 'Fewer than three unused IDs exist in this format. Add more letter or digit slots.' : 'Could not find three unused IDs within the search limit. Change or widen the format.');
    }
}

export function previewOptions(strings, column) {
    if (column.type === 'empty') return { values: [null], exception: 'Empty column: null is allowed.' };
    if (column.type === 'boolean') return { values: [true, false], exception: 'Boolean values may repeat source values.' };
    if (column.type === 'number') {
        const seen = new Set(strings.map(Number));
        if (seen.size === 2 && seen.has(0) && seen.has(1)) return { values: [0, 1], exception: 'Binary 0/1 values may repeat source values.' };
        const { min, max } = column.stats;
        const candidates = [];
        for (let i = 1; i <= 512 && candidates.length < 3; i++) {
            const fraction = i / 513;
            let value = min * (1 - fraction) + max * fraction;
            if (column.numericKind === 'integer') value = Math.round(value);
            else value = Number(value.toPrecision(12));
            if (!Number.isFinite(value) || value < min || value > max || (column.numericKind === 'integer' && !Number.isSafeInteger(value))) continue;
            if (!seen.has(value) && !candidates.includes(value)) candidates.push(value);
        }
        return { values: candidates, blocked: candidates.length ? '' : 'No unused numeric value found within the observed range. A constant or exhausted range cannot satisfy novelty; no out-of-range value was invented.' };
    }
    const seen = new Set(strings.map(canonical));
    const candidates = [];
    // There can be at most 20,000 occupied candidates under the table row limit.
    for (let i = 1; candidates.length < 3 && i <= strings.length + 3; i++) {
        const value = `Synthetic text example ${i}.`;
        if (!seen.has(canonical(value))) candidates.push(value);
    }
    const genericValues = seen.size && [...seen].every(value => GENERIC.includes(value)) ? GENERIC.filter(value => seen.has(value)) : [];
    return { values: candidates, genericValues, note: 'Fixed fictional text; not a paraphrase. Does not reproduce source semantics, formatting or length.' };
}

export const columnPromptName = (column, table) => (column.shareName ?? table.includeColumnNames ?? true) ? column.source : column.alias;

export function syntheticPreview(table, { useColumnNames = false } = {}) {
    const issues = [], exceptions = [];
    const label = c => useColumnNames ? columnPromptName(c, table) : c.alias;
    if (new Set(table.columns.map(label)).size !== table.columns.length) issues.push('Example column names overlap. Change the Column name switches so every example header is unique.');
    const pools = table.columns.map(c => {
        if (c.identifierFormat) {
            if (c.identifierIssue || c.identifierValues?.length !== 3) {
                issues.push(`${label(c)}: ${c.identifierIssue || 'Configure the identifier format first.'}`);
                return [];
            }
            return c.identifierValues;
        }
        if (c.exampleIssue) { issues.push(`${label(c)}: ${c.exampleIssue}`); return []; }
        if (c.modelExamples) {
            configureModelExamples(c, [...c.modelExamples]);
            if (c.exampleIssue) { issues.push(`${label(c)}: ${c.exampleIssue}`); return []; }
            exceptions.push(`${label(c)}: AI-proposed examples; type/range and source collisions checked, meaning and relationships require review.`);
            return c.modelExamples;
        }
        const options = c.previewOptions;
        if (!options) { issues.push(`${label(c)}: reselect the data to enable preview.`); return []; }
        if (options.exception) exceptions.push(`${label(c)}: ${options.exception}`);
        if (c.allowGenericReuse && options.genericValues?.length) {
            exceptions.push(`${label(c)}: user approved reuse of fixed generic category labels.`);
            return options.genericValues;
        }
        if (!options.values.length) issues.push(`${label(c)}: ${options.blocked}`);
        return options.values;
    });
    return {
        method: 'Three illustrative rows, not a fitted synthetic dataset. Non-exempt values were checked against their own source column. Text comparisons ignore case, outer whitespace and Unicode compatibility differences; numeric comparisons use numeric equality.',
        limitations: 'No semantic, clinical, distributional, cross-column or referential-integrity guarantee. Novel values alone do not establish anonymity. Boolean, binary, null and explicitly approved generic values may repeat; whole rows consisting of these values may also repeat.',
        exceptions, issues,
        rows: issues.length ? [] : Array.from({ length: 3 }, (_, row) => Object.fromEntries(table.columns.map((c, i) => [label(c), pools[i][row % pools[i].length]]))),
    };
}
