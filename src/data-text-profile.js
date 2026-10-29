// Structural descriptions use fixed vocabulary. Opt-in value summaries stay in memory.
let textValues = new WeakMap();
export function clearTextValues() { textValues = new WeakMap(); }
export function registerTextValues(column, strings) {
    const counts = new Map();
    for (const value of strings) counts.set(value, (counts.get(value) || 0) + 1);
    const entries = [...counts].sort((a, b) => b[1] - a[1]);
    const reasons = [];
    if (entries.some(([, count]) => count < 5)) reasons.push('At least one value occurs fewer than 5 times');
    if (counts.size > 20) reasons.push('More than 20 distinct values');
    if (counts.size / strings.length > .2) reasons.push('Distinct values exceed 20% of non-empty cells');
    if (entries.some(([value]) => Array.from(value).length > 120)) reasons.push('Long text values');
    const values = entries.slice(0, 20).map(([value, count]) => ({ value: Array.from(value).slice(0, 120).join(''), count, percent: 100 * count / strings.length, truncated: Array.from(value).length > 120 }));
    textValues.set(column, { values, omittedDistinct: Math.max(0, counts.size - 20), nonMissing: strings.length });
    column.shareTextValues = reasons.length === 0;
    column.textValuesDefaultReason = reasons.length ? `Off by default: ${reasons.join('; ')}.` : 'On by default: at most 20 distinct values, each occurring at least 5 times, and at most 20% distinct/non-empty cells.';
}
export function getTextValues(column) {
    const summary = textValues.get(column);
    return summary ? { ...summary, values: summary.values.map(value => ({ ...value })) } : null;
}
const PATTERNS = [
    { id: 'multiline', label: 'Multiple lines', test: text => /[\r\n]/.test(text), challenge: 'Preserve line breaks and support quoted multiline fields.', example: 'An item was reviewed.\nA follow-up is needed.' },
    { id: 'spacing', label: 'Irregular whitespace', test: text => text !== text.trim() || /[\t]| {2,}/.test(text), challenge: 'Handle leading, trailing and repeated whitespace consistently.', example: '  The item  was reviewed.  ' },
    { id: 'digits', label: 'Embedded numbers', test: text => /\p{N}/u.test(text), challenge: 'Text contains numbers; distinguish measurements from identifiers. Never reuse source numbers.', example: 'There are [quantity] items to review.' },
    { id: 'shorthand', label: 'Possible shorthand', test: text => /\b[A-Z]{2,8}\b|\b\p{L}{1,3}\.(?:\s|$)/u.test(text), challenge: 'Possible abbreviations or uppercase tokens may need domain definitions. This heuristic cannot identify their meaning.', example: '[abbreviation]: review is pending.' },
    { id: 'negation', label: 'Possible negation', test: text => /\b(?:no|not|never|without|geen|niet|nooit|zonder)\b/i.test(text), challenge: 'Preserve negation and its scope. Matching English/Dutch keywords does not establish meaning.', example: 'The item is not available.' },
    { id: 'lists', label: 'List-like formatting', test: text => /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s/.test(text), challenge: 'Preserve list boundaries rather than flattening unrelated statements.', example: '- Review the item.\n- Record the outcome.' },
    { id: 'delimiters', label: 'Delimiters or quotes', test: text => /[,;"\t]/.test(text), challenge: 'Quote and escape delimiters when exporting CSV/TSV.', example: 'The status is "pending"; another review is needed.' },
    { id: 'unicode', label: 'Non-ASCII characters', test: text => /[^\x00-\x7F]/.test(text), challenge: 'Preserve Unicode encoding. Accents or symbols do not establish the language.', example: 'Status → pending.' },
];

export function profileText(strings) {
    // Avoid surfacing isolated quirks: every displayed pattern must occur in at
    // least five cells. This suppression is not differential privacy.
    const patterns = [];
    if (strings.length >= 5) {
        for (const pattern of PATTERNS) {
            const count = strings.reduce((n, text) => n + Number(pattern.test(text)), 0);
            if (count < 5) continue;
            patterns.push({ label: pattern.label, prevalence: count / strings.length >= .5 ? 'common' : 'occasional', challenge: pattern.challenge, fictionalExample: pattern.example });
        }
    }
    return {
        method: 'Structural heuristics only; no names, entities, topics or original passages retained. Each reported pattern occurs in at least five non-empty cells.',
        limitations: 'Not a semantic or language analysis. No claim of detecting all identifiers, misspellings, clinical meaning or rare challenges. Fixed examples illustrate formatting, not source content.',
        patterns,
    };
}
