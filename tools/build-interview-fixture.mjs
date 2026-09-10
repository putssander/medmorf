#!/usr/bin/env node
// Build tests/fixtures/anonymize-interview.json from the synthetic oncology
// interview transcript and its two gold files:
//   tests/fixtures/interview-gold/gold_phi_annotations.json
//     entities [{ text, label, action }] → pii items (label/action kept), and
//     clinical_information_to_retain → `retain` (must survive de-identification)
//   tests/fixtures/interview-gold/gold_reidentification_risks.json
//     risk_groups → `riskGroups` (quasi-identifier sets for re-identification scoring)
// Usage: node tools/build-interview-fixture.mjs [transcript.md]
// Without a transcript path the text already in the fixture is reused. The
// trailing "In het transcript bewust opgenomen…" section of the markdown is
// not part of the document and is cut off.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'tests', 'fixtures', 'anonymize-interview.json');
const goldDir = path.join(root, 'tests', 'fixtures', 'interview-gold');
const phi = JSON.parse(fs.readFileSync(path.join(goldDir, 'gold_phi_annotations.json'), 'utf8'));
const risks = JSON.parse(fs.readFileSync(path.join(goldDir, 'gold_reidentification_risks.json'), 'utf8'));

let text;
const mdPath = process.argv[2];
if (mdPath) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const h = md.indexOf('## In het transcript bewust opgenomen');
    const cut = h >= 0 ? md.lastIndexOf('---', h) : md.length;
    text = md.slice(0, cut).trimEnd() + '\n';
} else {
    text = JSON.parse(fs.readFileSync(out, 'utf8')).documents[0].text;
}

// Gold label → Medmorf type (scoring ignores type for recall; this drives the per-type rows).
function mapLabel(label) {
    if (/NAME$/.test(label)) return 'PERSON';
    if (/^(CITY|TRAVEL_LOCATION)$/.test(label)) return 'LOCATION';
    if (/^(STREET|STREET_OR_LOCATION|STREET_OR_NEIGHBORHOOD|HOUSE_NUMBER_REFERENCE)$/.test(label)) return 'ADDRESS';
    if (/^(HEALTHCARE_ORGANIZATION|HOSPITAL|EMPLOYER|EDUCATIONAL_INSTITUTION|INSURER)$/.test(label)) return 'ORGANIZATION';
    if (/_ID$/.test(label)) return 'ID_NUMBER';
    if (/DATE/.test(label)) return 'DATE';
    if (/AGE$/.test(label)) return 'AGE';
    if (/PHONE/.test(label)) return 'PHONE';
    if (/EMAIL/.test(label)) return 'EMAIL';
    return 'MISC';
}
const seen = new Set();
const pii = [];
for (const e of phi.entities) {
    const t = String(e.text).trim();
    if (!text.includes(t)) throw new Error(`gold entity not found verbatim in transcript: "${t}"`);
    const type = mapLabel(e.label);
    const key = `${t.toLowerCase()}::${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pii.push({ text: t, type, label: e.label, action: e.action });
}
const retain = (phi.clinical_information_to_retain || []).map(String);
const riskGroups = (risks.risk_groups || []).map(g => ({ id: g.id, level: g.risk_level, category: g.category, elements: g.elements.map(String), reason: g.reason, action: g.recommended_action }));
// Role words: neither identifiers nor clinical content, fine to over-redact.
const allowed = ['Interviewer', 'Respondent', 'huisarts', 'chirurg', 'oncoloog', 'mammacareverpleegkundige', 'bedrijfsarts', 'fysiotherapeut', 'oncologiefysiotherapeut', 'verpleegkundige', 'verpleegkundig specialist', 'gynaecoloog', 'medisch psycholoog', 'radiotherapeut', 'radioloog', 'patholoog', 'leidinggevende', 'werkgever', 'buurvrouw', 'havo', 'Google', 'Nederland', 'Nederlandse'];

const fixture = {
    _comment: `Synthetic Dutch oncology patient interview (fictional; ~34k chars, transcript style) written by Sander Puts as de-identification test material, with two gold layers (tests/fixtures/interview-gold/): (1) ${pii.length} direct and standard identifiers with the gold label and recommended action kept per item (entity-level recall / precision, scored by tests/metrics.js scorePII with whole-word overlap); (2) ${riskGroups.length} re-identification risk groups of quasi-identifiers (${retain.length} clinical concepts to retain) scored by scoreReidentification: quasi-identifier recall, risk-group coverage (≥ half of a group's elements neutralised) and over-redaction of clinical content. Rebuild with tools/build-interview-fixture.mjs. Professions and clinical details appear only in the risk groups, not as entities: the app does not detect professions yet, and clinical terms must be kept.`,
    source: { transcript: 'Synthetisch Nederlands oncologie-interview voor de-identificatietest.md', gold: ['interview-gold/gold_phi_annotations.json', 'interview-gold/gold_reidentification_risks.json'], document_id: phi.document_id, synthetic: true },
    types: ['PERSON', 'DATE', 'ADDRESS', 'LOCATION', 'PHONE', 'EMAIL', 'ID_NUMBER', 'ORGANIZATION', 'AGE'],
    metrics: risks.benchmark_scoring,
    documents: [{ id: 'nl_oncologie_interview', language: 'nl', text, pii, allowed, retain, riskGroups }],
};
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
const perType = {}; for (const p of pii) perType[p.type] = (perType[p.type] || 0) + 1;
console.log(`wrote ${out}: ${pii.length} entities`, perType, `${retain.length} retain concepts, ${riskGroups.length} risk groups / ${riskGroups.reduce((n, g) => n + g.elements.length, 0)} elements`);
