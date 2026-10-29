// Verify generated F1 against per-document scores and recomputed model unions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PUBLISHED_BENCHMARK as published } from '../src/benchmark-published.js';
import { scoreAnonDoc, mean } from './metrics.js';
const read = path => JSON.parse(fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
const raw = read(published.sourceFile);
const latest = (model, set) => raw.results.findLast(r => r.model === model && r.set === set);
const check = (result, scores) => {
    for (const key of ['recall', 'precision', 'f1']) {
        const expected = mean(scores.map(s => key === 'f1' ? (s.precision + s.recall ? 2 * s.precision * s.recall / (s.precision + s.recall) : 0) : s[key]));
        assert.equal(result[key], +expected.toFixed(3), `${key} must average document scores`);
    }
};
for (const set of published.sets) {
    const fixtures = read(`tests/fixtures/${set.key}.json`);
    for (const [id, model] of Object.entries(published.models)) {
        const result = model.results[set.key];
        if (result?.status !== 'pass') { assert.equal(result?.f1, undefined); continue; }
        check(result, latest(id, set.key).docs.map(d => d.score));
    }
    for (const union of published.unions) {
        if (!union.results[set.key]) continue;
        const ner = latest(union.ner, set.key), llm = latest(union.llm, set.key);
        const scores = ner.docs.flatMap(n => {
            const l = llm.docs.find(d => d.id === n.id);
            const doc = fixtures.documents.find(d => d.id === n.id);
            return l && doc ? [scoreAnonDoc(doc, [...n.output.predictions, ...l.output.predictions])] : [];
        });
        check(union.results[set.key], scores);
    }
}
// The published ranking is by F1 averaged over the sets; the app's anonymize defaults must follow it.
const meanF1 = results => published.sets.reduce((n, set) => n + (results[set.key]?.f1 ?? 0), 0) / published.sets.length;
const bestUnion = published.unions.slice().sort((a, b) => meanF1(b.results) - meanF1(a.results))[0];
assert.deepEqual(published.best, { ner: bestUnion.ner, llm: bestUnion.llm, label: bestUnion.label }, 'best must be the union with the highest mean F1');
const bestDetector = Object.entries(published.models).filter(([, m]) => m.kind === 'ner').sort(([, a], [, b]) => meanF1(b.results) - meanF1(a.results))[0][0];
const handler = fs.readFileSync(new URL('../src/anonymize-handler.js', import.meta.url), 'utf8');
const constant = name => handler.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
assert.equal(constant('DEFAULT_ANON_NER_MODEL_ID'), published.best.ner, 'default detector must be the best-F1 combination');
assert.equal(constant('DEFAULT_MODEL'), published.best.llm, 'default LLM must be the best-F1 combination');
assert.equal(constant('FALLBACK_ANON_NER_MODEL_ID'), bestDetector, 'fallback detector must be the best-F1 detector-only model');
console.log('PASS: published recall, precision and document-averaged F1 match raw runs and recomputed unions; anonymize defaults follow the best mean F1.');
