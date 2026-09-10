#!/usr/bin/env node
// Turn a Benchmark-tab JSON export (or the CDP driver's dump) into the Markdown
// tables published in docs/BENCHMARKS.md. Recomputes every NER × LLM union from
// the stored per-document predictions with tests/metrics.js, so the report is
// reproducible from the raw export.
// Usage: node tools/benchmark-report.mjs <export.json> [--title "…"] [--intro notes.md] > docs/BENCHMARKS.md
import fs from 'node:fs';
import path from 'node:path';
import { scoreAnonDoc, mean } from '../tests/metrics.js';

const [,, file, ...rest] = process.argv;
if (!file) { console.error('usage: node tools/benchmark-report.mjs <export.json> [--title "…"]'); process.exit(1); }
const title = rest.includes('--title') ? rest[rest.indexOf('--title') + 1] : 'Anonymize benchmark';
const intro = rest.includes('--intro') ? fs.readFileSync(rest[rest.indexOf('--intro') + 1], 'utf8').trim() : '';
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
        recall: mean(scores.map(s => s.recall)), precision: mean(scores.map(s => s.precision)),
        microRecall: micro.t ? micro.d / micro.t : null, perType,
        quasi: reids.length ? mean(reids.map(r => r.quasiRecall).filter(x => x != null)) : null,
        groups: reids.length ? `${reids.reduce((n, r) => n + r.groupsCovered, 0)}/${reids.reduce((n, r) => n + r.groupsTotal, 0)}` : null,
        over: reids.length ? mean(reids.map(r => r.overRedactionRate).filter(x => x != null)) : null,
        lost: reids.flatMap(r => r.lostConcepts || []),
    };
}
const typeCols = ['PERSON', 'DATE', 'ADDRESS', 'LOCATION', 'PHONE', 'EMAIL', 'ID_NUMBER', 'ORGANIZATION', 'AGE', 'PROFESSION'];
const perTypeCell = (pt) => typeCols.filter(t => pt[t]).map(t => `${t.replace('ORGANIZATION', 'ORG').replace('ID_NUMBER', 'ID').replace('LOCATION', 'LOC').replace('ADDRESS', 'ADDR').replace('PROFESSION', 'PROF')} ${pt[t].detected}/${pt[t].total}`).join(', ');

const lines = [`# ${title}`, '', `Generated ${new Date(data.generated || Date.now()).toISOString().slice(0, 10)} with \`tools/benchmark-report.mjs\` from a Benchmark-tab export.`, ''];
if (intro) lines.push(intro, '');
if (data.env) lines.push(`Environment: ${typeof data.env === 'string' ? data.env : JSON.stringify(data.env)}`, '');
lines.push('Method: documents chunked as in the app (2400 chars, 240 overlap); LLM output passed through the app\'s sanity filter; entity scoring = whole-word text overlap (recall per document, averaged; "micro" = pooled over all identifiers); quasi-ID / risk groups / over-redaction only for sets with gold risk groups (see README → Model Benchmark). NER + LLM rows are computed unions of the stored predictions (the app\'s hybrid pipeline; precision is a lower bound because the LLM validation pass is not simulated).', '');

for (const [set, desc] of Object.entries(SETS)) {
    const ners = latest('ner', set), llms = latest('anonllm', set);
    if (!ners.length && !llms.length) continue;
    const hasReid = fixtures[set].documents.some(d => d.riskGroups);
    lines.push(`## ${desc}`, '');
    const head = ['Model', 'Kind', 'Load', 'Inference / doc', 'Peak heap Δ', 'Recall (doc avg)', 'Recall (micro)', 'Precision', ...(hasReid ? ['Quasi-ID', 'Risk groups', 'Over-redaction'] : []), 'Per type', 'Status'];
    lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    const row = (r, kind) => {
        const ok = r.status === 'pass';
        const a = ok ? aggregate(r.docs.map(d => d.score)) : null;
        const cells = [r.label || r.model, kind, ms(r.loadMs), ms(r.inferMsPerDoc), r.heapSupported ? '+' + mb(r.heapPeakDeltaMB) : 'n/a', ok ? pct(a.recall) : '—', ok ? pct(a.microRecall) : '—', ok ? pct(a.precision) : '—'];
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
        const cells = [`${n.label} + ${l.label}`, 'NER + LLM (union)', '—', ms((n.inferMsPerDoc || 0) + (l.inferMsPerDoc || 0)), '—', pct(a.recall), pct(a.microRecall), pct(a.precision)];
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
