// Offline regression examples. These exercise production code, not actual inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { profileTable, getContentSamples, applyColumnDrafts, configureIdentifier, syntheticPreview, buildPrompt } from '../src/data-profile.js';
import { parseDraftJSON, draftResponseIssues, mergeDraftResponse, draftResponseDiagnostics } from '../src/data-prompt-drafts.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/data-prompt-responses.json', import.meta.url)));
const loadTable = async name => {
    const rows = JSON.parse(await readFile(new URL(`./fixtures/data-prompt-folder/${name}.json`, import.meta.url)));
    const keys = Object.keys(rows[0]);
    return profileTable([keys, ...rows.map(row => keys.map(key => row[key]))], name);
};
for (const example of fixture.parserCases) test(`response example: ${example.name}`, () => {
    if (example.reject) assert.throws(() => parseDraftJSON(example.text));
    else assert.deepEqual(parseDraftJSON(example.text), example.expected);
    const metadata = draftResponseDiagnostics({ choices: [{ finish_reason: example.name.startsWith('truncated') ? 'length' : 'stop', message: { content: example.text } }] });
    assert.equal(metadata.parseableObject, !example.reject);
    assert.equal(metadata.characters, example.text.length);
    assert.equal(Object.hasOwn(metadata, 'content'), false);
});

test('fictional folder: per-file statistics, roles and strict sample bounds', async () => {
    const records = await loadTable('records'), visits = await loadTable('visits');
    assert.equal(records.rows, 6);
    assert.equal(visits.rows, 3);
    const [id, age, active, note] = records.columns;
    assert.equal(id.evidence.candidateRole, 'identifier');
    assert.equal(id.evidence.leadingZeros, true);
    assert.equal(id.evidence.dominantCharacterFormat, '9999');
    assert.deepEqual([age.stats.min, age.stats.max, age.stats.mean, age.missing], [20, 60, 40, 1]);
    assert.deepEqual([active.stats.trueCount, active.stats.falseCount, active.missing], [3, 2, 1]);
    assert.equal(note.stats.textLength.max, 38);
    assert.equal(getContentSamples(note).length, 4);
    assert.ok(!getContentSamples(note).join('').includes('SIXTH_ROW_SENTINEL'));
    assert.equal(visits.columns[1].evidence.candidateRole, 'reference');
    assert.equal(visits.columns[2].evidence.candidateRole, 'datetime');
    assert.equal(visits.columns[3].numericKind, 'decimal');
});

test('four-column example: partial retry retains completed fields and ignores unknown aliases', () => {
    const payload = { columns: fixture.columns.map(({ alias }) => ({ alias })) };
    const partial = structuredClone({ columns: fixture.columns });
    partial.columns[2].semanticRole = 'bool';
    delete partial.columns[3].rules;
    const saved = mergeDraftResponse({}, partial, payload);
    assert.deepEqual(draftResponseIssues(saved, payload), ['column_3.semanticRole', 'column_4.rules']);
    const repair = { columns: [fixture.columns[2], fixture.columns[3], { alias: 'column_999', description: 'Ignore' }] };
    repair.columns = structuredClone(repair.columns);
    repair.columns[0].description = 'Do not overwrite completed description';
    const merged = mergeDraftResponse(saved, repair, payload);
    assert.deepEqual(draftResponseIssues(merged, payload), []);
    assert.deepEqual(merged, { columns: fixture.columns });
    const duplicate = { columns: Array(4).fill(fixture.columns[0]) };
    assert.equal(draftResponseIssues(duplicate, payload).length, 3);
});

test('fictional drafts produce new IDs and a prompt without sample text', async () => {
    const table = await loadTable('records');
    applyColumnDrafts(table, { columns: fixture.columns }, configureIdentifier);
    assert.equal(table.columns[0].identifierIssue, '');
    const preview = syntheticPreview(table);
    assert.equal(preview.rows.length, 3);
    const ids = table.columns[0].identifierValues;
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) {
        assert.match(id, /^\d{4}$/);
        assert.ok(!['0001','0002','0003','0004','0005','0006'].includes(id));
    }
    const prompt = buildPrompt([table], fixture.brief);
    assert.ok(prompt.includes('record_id'));
    for (const marker of ['SIXTH_ROW_SENTINEL', 'Fictieve notitie', 'Fictional note:']) assert.ok(!prompt.includes(marker));
    assert.deepEqual(draftResponseIssues(fixture.brief, { currentBrief: {} }), []);
    assert.deepEqual(draftResponseIssues({ ...fixture.brief, count: 0, format: 'XML' }, { currentBrief: {} }), ['brief.count', 'brief.format']);
});
