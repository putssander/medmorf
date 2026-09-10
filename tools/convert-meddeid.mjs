#!/usr/bin/env node
// Convert a sample of the MedDeID Dutch synthetic benchmark (Hellemans et al.,
// University of Antwerp / UZA, CC BY 4.0, https://doi.org/10.5281/zenodo.21890965)
// into the Medmorf anonymize fixture format used by tests/metrics.js:
//   { types, documents: [{ id, language, text, pii: [{ text, type }], allowed: [] }] }
//
// Usage:
//   node tools/convert-meddeid.mjs <unzipped-archive-dir> [out.json] [count] [seed]
// Default: all "targeted-difficult" documents plus a seeded random sample of the
// synthetic ones, 24 documents in total, written to tests/fixtures/anonymize-meddeid.json.
//
// Label mapping (MedDeID category → Medmorf type). Recall scoring in metrics.js
// ignores the type (any overlapping prediction counts), so the mapping only
// drives the per-type breakdown:
//   Name → PERSON · Date → DATE · Age_Birthdate → AGE (age phrases) or DATE (birth dates)
//   Contactdetails → EMAIL (contains @) or PHONE · Address_Location → ADDRESS (has a
//   number or street word) or LOCATION · Organization → ORGANIZATION · ID → ID_NUMBER
//   Profession → PROFESSION (not detected by the app yet; kept because the source
//   corpus treats it as identifying).
// The original MedDeID label is preserved on every item as `label`.
import fs from 'node:fs';
import path from 'node:path';

const [,, archiveDir, outArg, countArg, seedArg] = process.argv;
if (!archiveDir) { console.error('usage: node tools/convert-meddeid.mjs <archive-dir> [out.json] [count] [seed]'); process.exit(1); }
const out = outArg || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tests', 'fixtures', 'anonymize-meddeid.json');
const count = Number(countArg) || 24;
const seed = Number(seedArg) || 20260910;

const file = path.join(archiveDir, 'data', 'meddeid-dutch-synthetic-benchmark.jsonl');
const docs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
docs.sort((a, b) => a.document_id.localeCompare(b.document_id));

// Deterministic sample: every targeted-difficult doc + seeded picks from the rest.
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(seed);
const hard = docs.filter(d => d.document_id.startsWith('targeted-difficult'));
const rest = docs.filter(d => !d.document_id.startsWith('targeted-difficult'));
for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
const picked = [...hard, ...rest.slice(0, Math.max(0, count - hard.length))].sort((a, b) => a.document_id.localeCompare(b.document_id));

const STREET = /(straat|laan|weg|plein|gracht|dijk|kade|singel|hof|pad|steeg|dreef|lei|baan|avenue|rue|chemin|boulevard)\b/i;
function mapType(span) {
    const t = span.text;
    switch (span.category) {
        case 'Name': return 'PERSON';
        case 'Date': return 'DATE';
        case 'Age_Birthdate': return /\b(jaar|jarige?|jr|j)\b\.?$/i.test(t) || /^\d{1,3}$/.test(t.trim()) || /jarige/i.test(t) ? 'AGE' : 'DATE';
        case 'Contactdetails': return t.includes('@') ? 'EMAIL' : 'PHONE';
        case 'Address_Location': return /\d/.test(t) || STREET.test(t) ? 'ADDRESS' : 'LOCATION';
        case 'Organization': return 'ORGANIZATION';
        case 'ID': return 'ID_NUMBER';
        case 'Profession': return 'PROFESSION';
        default: return String(span.category || 'MISC').toUpperCase();
    }
}

const documents = picked.map(d => {
    const seen = new Set();
    const pii = [];
    for (const s of d.spans) {
        const text = d.text.slice(s.begin, s.end);
        if (text !== s.text) throw new Error(`offset mismatch in ${d.document_id}: "${text}" vs "${s.text}"`);
        const clean = text.trim();
        if (clean.length < 2) continue;
        const type = mapType(s);
        const key = `${clean.toLowerCase()}::${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pii.push({ text: clean, type, label: s.label });
    }
    return { id: `meddeid_${d.document_id}`, language: 'nl', text: d.text, pii, allowed: [] };
});

const fixture = {
    _comment: `Sample of ${documents.length} documents from the MedDeID Dutch synthetic benchmark (300 physician-reviewed synthetic Belgian-Dutch clinical notes; no real patients). Source: Hellemans S. et al., "MedDeID Dutch synthetic corpus, synthetic benchmark and annotation guidelines", Adrem Data Lab, University of Antwerp / Antwerp University Hospital, 2026, CC BY 4.0, https://doi.org/10.5281/zenodo.21890965. Converted by tools/convert-meddeid.mjs (all ${hard.length} "targeted-difficult" documents plus ${documents.length - hard.length} seeded-random synthetic ones, seed ${seed}); each pii item keeps the original MedDeID label. Scoring is Medmorf's lenient text-overlap scoring (tests/metrics.js), not MedDeID's span-level evaluation, so numbers are comparable between models here but not with the MedDeID paper. Note Belgian conventions (+32 phones, rijksregister-style IDs, Flemish hospital names). \`allowed\` is empty: the source leaves non-identifying clinical terms unmarked, so precision is stricter than on anonymize.json.`,
    source: { title: 'MedDeID Dutch synthetic corpus, synthetic benchmark and annotation guidelines', authors: 'Hellemans S., Stroobants T., Scheurwegs E., Meysman P., Jorens P., Laukens K.', doi: '10.5281/zenodo.21890965', license: 'CC-BY-4.0', file: 'data/meddeid-dutch-synthetic-benchmark.jsonl', seed, count: documents.length },
    types: ['PERSON', 'DATE', 'ADDRESS', 'LOCATION', 'PHONE', 'EMAIL', 'ID_NUMBER', 'ORGANIZATION', 'AGE', 'PROFESSION'],
    documents,
};
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
const perType = {};
for (const d of documents) for (const p of d.pii) perType[p.type] = (perType[p.type] || 0) + 1;
console.log(`wrote ${out}: ${documents.length} docs, ${documents.reduce((n, d) => n + d.pii.length, 0)} pii items`, perType);
