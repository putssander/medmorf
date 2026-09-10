#!/usr/bin/env node
// Turn a Benchmark-tab JSON export (or the CDP driver's dump) into the Markdown
// tables published in docs/BENCHMARKS.md. Recomputes every NER × LLM union from
// the stored per-document predictions with tests/metrics.js, so the report is
// reproducible from the raw export.
// Usage: node tools/benchmark-report.mjs <export.json> [--title "…"] [--intro notes.md] [--summary-js src/benchmark-published.js] > docs/BENCHMARKS.md
// --summary-js writes the compact module the app reads (Benchmark page).
import fs from 'node:fs';
import path from 'node:path';
import { scoreAnonDoc, mean } from '../tests/metrics.js';

const [,, file, ...rest] = process.argv;
if (!file) { console.error('usage: node tools/benchmark-report.mjs <export.json> [--title "…"]'); process.exit(1); }
const title = rest.includes('--title') ? rest[rest.indexOf('--title') + 1] : 'Anonymize benchmark';
const intro = rest.includes('--intro') ? fs.readFileSync(rest[rest.indexOf('--intro') + 1], 'utf8').trim() : '';
const summaryJs = rest.includes('--summary-js') ? rest[rest.indexOf('--summary-js') + 1] : '';
const rel = (f) => path.relative(root, path.resolve(f));
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = data.results || [];
const SETS = { 'anonymize': 'App fixtures (4 short synthetic notes, NL + EN)', 'anonymize-interview': 'Oncology interview (1 long synthetic NL transcript, 64 identifiers, 18 risk groups)', 'anonymize-meddeid': 'MedDeID sample (24 synthetic Belgian-Dutch clinical notes, 259 identifiers)' };
const fixtures = Object.fromEntries(Object.keys(SETS).map(k => [k, JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', `${k}.json`), 'utf8'))]));
const pct = (x) => x == null || !isFinite(x) ? '—' : (x * 100).toFixed(0) + '%';
const ms = (x) => x == null ? '—' : x >= 1000 ? (x / 1000).toFixed(1) + ' s' : Math.round(x) + ' ms';
const mb = (x) => x == null || !isFinite(x) ? '—' : x >= 1024 ? (x / 1024).toFixed(2) + ' GB' : Math.round(x) + ' MB';

function latest(section, set) {
    const seen = new Set(); const out = [];
    for (let i = results.length - 1; i >= 0; i--) { const r = results[i]; if (r.section === section && r.set === set && !seen.has(r.model)) { seen.add(r.model); out.push(r); } }
    return out.reverse();
}
function aggregate(scores) {
    const perType = {};
    for (const s of scores) for (const [t, v] of Object.entries(s.perType || {})) { perType[t] ??= { total: 0, detected: 0 }; perType[t].total += v.total; perType[t].detected += v.detected; }
    const reids = scores.map(s => s.reid).filter(Boolean);
    const micro = Object.values(perType).reduce((a, v) => ({ d: a.d + v.detected, t: a.t + v.total }), { d: 0, t: 0 });
    return {
        recall: mean(scores.map(s => s.recall)), precision: mean(scores.map(s => s.precision)), f1: mean(scores.map(s => s.f1 ?? (s.precision + s.recall ? 2 * s.precision * s.recall / (s.precision + s.recall) : 0))),
        microRecall: micro.t ? micro.d / micro.t : null, perType,
        quasi: reids.length ? mean(reids.map(r => r.quasiRecall).filter(x => x != null)) : null,
        groups: reids.length ? `${reids.reduce((n, r) => n + r.groupsCovered, 0)}/${reids.reduce((n, r) => n + r.groupsTotal, 0)}` : null,
        over: reids.length ? mean(reids.map(r => r.overRedactionRate).filter(x => x != null)) : null,
        lost: reids.flatMap(r => r.lostConcepts || []),
    };
}
const typeCols = ['PERSON', 'DATE', 'ADDRESS', 'LOCATION', 'PHONE', 'EMAIL', 'ID_NUMBER', 'ORGANIZATION', 'AGE', 'PROFESSION'];
const perTypeCell = (pt) => typeCols.filter(t => pt[t]).map(t => `${t.replace('ORGANIZATION', 'ORG').replace('ID_NUMBER', 'ID').replace('LOCATION', 'LOC').replace('ADDRESS', 'ADDR').replace('PROFESSION', 'PROF')} ${pt[t].detected}/${pt[t].total}`).join(', ');

const lines = [`# ${title}`, '', `Generated ${new Date(data.generated || Date.now()).toISOString().slice(0, 10)} with \`tools/benchmark-report.mjs\`.`, '', `**Produced from:** raw export \`${rel(file)}\` (every model's per-document predictions, misses and timings)${intro ? `, conclusions \`${rel(rest[rest.indexOf('--intro') + 1])}\`` : ''}; fixtures \`tests/fixtures/anonymize.json\`, \`tests/fixtures/anonymize-interview.json\` (+ \`interview-gold/\`), \`tests/fixtures/anonymize-meddeid.json\`; scoring \`tests/metrics.js\`. The same numbers are shown in the app (Benchmark page at https://medmorf.com/#benchmark) via \`src/benchmark-published.js\`.`, ''];
lines.push('Canonical results page: [Medmorf benchmarks](https://medmorf.com/#benchmark). This report and the page are generated from the same raw export.', '');
if (intro) lines.push(intro, '');
if (data.env) lines.push(`Environment: ${typeof data.env === 'string' ? data.env : JSON.stringify(data.env)}`, '');
lines.push('Method: documents chunked as in the app (2400 chars, 240 overlap); LLM output passed through the app\'s sanity filter; entity scoring = whole-word text overlap (recall, precision and F1 per document, averaged; "micro" = pooled over all identifiers); quasi-ID / risk groups / over-redaction only for sets with gold risk groups (see README → Model Benchmark). NER + LLM rows are computed unions of the stored predictions (the app\'s hybrid pipeline; precision is a lower bound because the LLM validation pass is not simulated).', '');

for (const [set, desc] of Object.entries(SETS)) {
    const ners = latest('ner', set), llms = latest('anonllm', set);
    if (!ners.length && !llms.length) continue;
    const hasReid = fixtures[set].documents.some(d => d.riskGroups);
    lines.push(`## ${desc}`, '');
    const head = ['Model', 'Kind', 'Load', 'Inference / doc', 'Peak heap Δ', 'Recall (doc avg)', 'Recall (micro)', 'Precision', 'F1 (doc avg)', ...(hasReid ? ['Quasi-ID', 'Risk groups', 'Over-redaction'] : []), 'Per type', 'Status'];
    lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    const row = (r, kind) => {
        const ok = r.status === 'pass';
        const a = ok ? aggregate(r.docs.map(d => d.score)) : null;
        const cells = [r.label || r.model, kind, ms(r.loadMs), ms(r.inferMsPerDoc), r.heapSupported ? '+' + mb(r.heapPeakDeltaMB) : 'n/a', ok ? pct(a.recall) : '—', ok ? pct(a.microRecall) : '—', ok ? pct(a.precision) : '—', ok ? pct(a.f1) : '—'];
        if (hasReid) cells.push(ok ? pct(a.quasi) : '—', ok ? (a.groups ?? '—') : '—', ok ? pct(a.over) + (a.lost.length ? ` (${a.lost.join(', ')})` : '') : '—');
        cells.push(ok ? perTypeCell(a.perType) : '—', ok ? 'pass' : `${r.status}${r.error ? ': ' + r.error : ''}${r.reason ? ': ' + r.reason : ''}`);
        return `| ${cells.join(' | ')} |`;
    };
    for (const r of ners) lines.push(row(r, 'NER'));
    for (const r of llms) lines.push(row(r, 'LLM'));
    // unions
    const docsById = new Map(fixtures[set].documents.map(d => [d.id, d]));
    for (const n of ners.filter(r => r.status === 'pass')) for (const l of llms.filter(r => r.status === 'pass')) {
        const ids = n.docs.map(d => d.id).filter(id => l.docs.some(d => d.id === id) && docsById.has(id));
        if (!ids.length) continue;
        const scores = ids.map(id => {
            const preds = [...(n.docs.find(d => d.id === id).output?.predictions || []), ...(l.docs.find(d => d.id === id).output?.predictions || [])];
            return scoreAnonDoc(docsById.get(id), preds);
        });
        const a = aggregate(scores);
        const cells = [`${n.label} + ${l.label}`, 'NER + LLM (union)', '—', ms((n.inferMsPerDoc || 0) + (l.inferMsPerDoc || 0)), '—', pct(a.recall), pct(a.microRecall), pct(a.precision), pct(a.f1)];
        if (hasReid) cells.push(pct(a.quasi), a.groups ?? '—', pct(a.over) + (a.lost.length ? ` (${a.lost.join(', ')})` : ''));
        cells.push(perTypeCell(a.perType), `computed on ${ids.length} docs`);
        lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
    // misses worth reading (interview / small sets): list missed identifiers for the best union
    if (set !== 'anonymize-meddeid') {
        for (const r of [...ners, ...llms].filter(r => r.status === 'pass')) {
            const missed = r.docs.flatMap(d => (d.output?.missed || d.score?.missed || []).map(m => `${m.text} (${m.type})`));
            if (missed.length) lines.push(`- **${r.label} missed:** ${missed.join('; ')}`);
        }
        lines.push('');
    }
}
process.stdout.write(lines.join('\n') + '\n');

// ── Compact summary module for the app ───────────────────────────────────────
if (summaryJs) {
    const setKeys = Object.keys(SETS);
    const models = {};
    const unions = [];
    for (const set of setKeys) {
        const ners = latest('ner', set), llms = latest('anonllm', set);
        const docsById = new Map(fixtures[set].documents.map(d => [d.id, d]));
        const put = (r, kind) => {
            const m = (models[r.model] ??= { label: r.label || r.model, kind, results: {} });
            if (r.status !== 'pass') { m.results[set] = { status: r.status, reason: r.reason || r.error || '' }; return; }
            const a = aggregate(r.docs.map(d => d.score));
            m.results[set] = { status: 'pass', recall: +a.recall.toFixed(3), precision: +a.precision.toFixed(3), f1: +a.f1.toFixed(3), quasi: a.quasi == null ? null : +a.quasi.toFixed(3), groups: a.groups, over: a.over == null ? null : +a.over.toFixed(3), inferMsPerDoc: Math.round(r.inferMsPerDoc || 0), heapMB: r.heapPeakDeltaMB == null ? null : Math.round(r.heapPeakDeltaMB) };
        };
        for (const r of ners) put(r, 'ner');
        for (const r of llms) put(r, 'llm');
        for (const n of ners.filter(r => r.status === 'pass')) for (const l of llms.filter(r => r.status === 'pass')) {
            const ids = n.docs.map(d => d.id).filter(id => l.docs.some(d => d.id === id) && docsById.has(id));
            if (!ids.length) continue;
            const a = aggregate(ids.map(id => scoreAnonDoc(docsById.get(id), [...(n.docs.find(d => d.id === id).output?.predictions || []), ...(l.docs.find(d => d.id === id).output?.predictions || [])])));
            let u = unions.find(x => x.ner === n.model && x.llm === l.model);
            if (!u) { u = { ner: n.model, llm: l.model, label: `${n.label} + ${l.label}`, results: {} }; unions.push(u); }
            u.results[set] = { recall: +a.recall.toFixed(3), precision: +a.precision.toFixed(3), f1: +a.f1.toFixed(3), quasi: a.quasi == null ? null : +a.quasi.toFixed(3), groups: a.groups, over: a.over == null ? null : +a.over.toFixed(3), docs: ids.length };
        }
    }
    const best = unions.slice().sort((a, b) => setKeys.reduce((n, k) => n + (b.results[k]?.recall || 0), 0) - setKeys.reduce((n, k) => n + (a.results[k]?.recall || 0), 0))[0] || null;
    const summary = {
        date: new Date(data.generated || Date.now()).toISOString().slice(0, 10),
        sourceFile: rel(file),
        notesFile: intro ? rel(rest[rest.indexOf('--intro') + 1]) : null,
        reportFile: 'docs/BENCHMARKS.md',
        environment: typeof data.env === 'string' ? data.env.split(' | Fixtures')[0] : JSON.stringify(data.env || {}),
        sets: setKeys.map(k => ({ key: k, label: SETS[k], docs: fixtures[k].documents.length, items: fixtures[k].documents.reduce((n, d) => n + d.pii.length, 0), reid: fixtures[k].documents.some(d => d.riskGroups) })),
        models, unions, best: best ? { ner: best.ner, llm: best.llm, label: best.label } : null,
    };
    const header = `// benchmark-published.js — GENERATED by tools/benchmark-report.mjs, do not edit.\n// Compact measured results shown in the app (Benchmark page).\n// Source export: ${summary.sourceFile} · report: ${summary.reportFile}\n`;
    fs.writeFileSync(summaryJs, header + 'export const PUBLISHED_BENCHMARK = ' + JSON.stringify(summary, null, 2) + ';\n');
    console.error(`wrote ${summaryJs}: ${Object.keys(models).length} models, ${unions.length} unions, best ${best?.label}`);
}
