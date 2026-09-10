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
console.log('PASS: published recall, precision and document-averaged F1 match raw runs and recomputed unions.');
