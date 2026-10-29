import assert from 'node:assert/strict';
import { profileTable, buildPrompt, missingContext } from '../src/data-profile.js';
const table = profileTable([['patient_name', 'age', 'mixed'], ['Alice Private', '20', '2'], ['Bob Secret', '30', 'unknown'], ['Alice Private', '', null], ['Cara Private', '40', '']], 'private-source.xlsx');
assert.equal(table.rows, 4);
assert.equal(table.columns[0].distinct, 3);
assert.equal(table.columns[1].missing, 1);
assert.equal(table.columns[1].stats.mean, 30);
assert.equal(table.columns[1].stats.q1, 25);
assert.equal(table.columns[1].stats.median, 30);
assert.ok(Math.abs(table.columns[1].stats.populationSD - Math.sqrt(200 / 3)) < 1e-10);
assert.equal(table.columns[2].type, 'text');
const context = { purpose: 'Test app', count: '100', relationships: 'none', format: 'CSV' };
assert.ok(buildPrompt([table], context).includes('"name": "patient_name"'));
for (const c of table.columns) c.shareName = false;
let prompt = buildPrompt([table], context);
for (const secret of ['Alice', 'Bob', 'patient_name', 'private-source', 'populationSD']) assert.ok(!prompt.includes(secret), secret);
assert.ok(!JSON.stringify(table).includes('Alice'));
table.columns[1].share = true;
prompt = buildPrompt([table], context);
assert.ok(prompt.includes('populationSD'));
assert.equal(missingContext([table], context).length, 7);
for (const c of table.columns) { c.description = 'Meaning'; c.units = 'unitless'; c.rules = 'Fictional only'; }
assert.equal(missingContext([table], context).length, 0);
assert.throws(() => profileTable([['a', 'a'], [1, 2]], 'duplicate'), /Duplicate/);
assert.throws(() => profileTable([['a'], [1, 2]], 'ragged'), /more fields/);
assert.throws(() => profileTable([['a'], [null]], 'empty'), /no populated/);
assert.throws(() => profileTable([['a'], ...Array.from({length: 20001}, () => [1])], 'large'), /Limit/);
const single = profileTable([['n', 'empty', 'bool'], ['2', '', true]], 'edge');
assert.equal(single.columns[0].stats.populationSD, 0);
assert.equal(single.columns[1].type, 'empty');
assert.equal(single.columns[2].type, 'boolean');
console.log('Data profile statistics, edge cases, context checklist and export boundaries passed.');
const descriptives = profileTable([
    ['measurement', 'note', 'flag', 'marker'],
    [10, 'a', true], [20, 'abc', false], [30, 'abcde', true], [40, 'abcdefg', null], [null, '  ', null, 'keep row'],
], 'descriptives');
const [measurement, note, flag] = descriptives.columns;
assert.equal(measurement.numericKind, 'integer');
assert.equal(measurement.nonMissing, 4);
assert.equal(measurement.missingPercent, 20);
assert.equal(measurement.stats.iqr, 15);
assert.ok(Math.abs(measurement.stats.sampleSD - Math.sqrt(500 / 3)) < 1e-10);
assert.deepEqual([note.stats.textLength.min, note.stats.textLength.max, note.stats.textLength.mean, note.stats.textLength.median, note.stats.textLength.q1, note.stats.textLength.q3, note.stats.textLength.iqr], [1, 7, 4, 4, 2.5, 5.5, 3]);
assert.equal(note.nonMissing, 4);
assert.equal(flag.stats.trueCount, 2);
assert.equal(flag.stats.falseCount, 1);
assert.equal(flag.stats.truePercent, 200 / 3);
assert.equal(single.columns[0].stats.sampleSD, null);
assert.equal(profileTable([['text'], ['😀']], 'unicode').columns[0].stats.textLength.mean, 1);
assert.equal(profileTable([['value'], ['1.5']], 'decimal').columns[0].numericKind, 'decimal');
descriptives.includeColumnNames = true;
note.share = true;
const descriptivePrompt = buildPrompt([descriptives], context);
assert.ok(descriptivePrompt.includes('"name": "note"'));
assert.ok(descriptivePrompt.includes('"textLength"'));
assert.ok(descriptivePrompt.includes('"missingPercent": 20'));
assert.ok(!descriptivePrompt.includes('abcdefg'));
console.log('Numeric and Unicode text-length summaries, sample SD, missingness, booleans and optional header export passed.');

// Exported example keys must match the column-name switches, without losing colliding keys.
const { syntheticPreview } = await import('../src/data-profile.js');
const examples = profileTable([['note', 'active'], ['Fictional source note', true], ['Another source note', false]], 'examples');
examples.sharePreview = true;
const exportedSchema = t => JSON.parse(buildPrompt([t], context).split('Schema and explicitly approved descriptive statistics:\n')[1].split('\n\nMissing context')[0])[0];
assert.deepEqual(Object.keys(exportedSchema(examples).syntheticExamples.rows[0]), ['note', 'active']);
examples.columns[0].shareName = false;
assert.deepEqual(Object.keys(exportedSchema(examples).syntheticExamples.rows[0]), ['column_1', 'active']);
examples.columns[0].shareName = true;
assert.deepEqual(Object.keys(exportedSchema(examples).syntheticExamples.rows[0]), ['note', 'active']);
const collision = profileTable([['column_2', 'note'], ['First text', 'Second text']], 'collision');
collision.columns[1].shareName = false;
collision.sharePreview = true;
assert.equal(syntheticPreview(collision, { useColumnNames: true }).rows.length, 0);
assert.equal(exportedSchema(collision).syntheticExamples, undefined);
console.log('Example keys follow column-name switches; colliding headers block export instead of dropping values.');

const { buildDescriptorPrompt } = await import('../src/data-profile.js');
examples.columns[0].share = true;
examples.columns[0].description = 'PHASE_TWO_DESCRIPTION';
examples.columns[0].harmonization = 'PHASE_TWO_MAPPING';
examples.columns[0].identifierFormat = 'AA-9999';
examples.sourceFile = { alias: 'file_1', path: 'PRIVATE_FILENAME', description: 'PHASE_TWO_FILE_DESCRIPTION' };
const descriptors = buildDescriptorPrompt([examples]);
for (const excluded of ['PHASE_TWO_', 'PRIVATE_FILENAME', 'Synthetic text example', 'AA-9999', 'Fictional source note']) assert.ok(!descriptors.includes(excluded));
assert.match(descriptors, /"rows": 2/);
assert.match(descriptors, /"textLength"/);
assert.match(descriptors, /"name": "note"/);
assert.match(descriptors, /"statistics": "Withheld by user"/);
assert.ok(!descriptors.includes('UNKNOWN'));
examples.columns[0].shareName = false;
assert.match(buildDescriptorPrompt([examples]), /"name": "column_1"/);
console.log('Phase 1 includes measured descriptors only, respects export switches and excludes all Phase 2 fields.');

const renamed = profileTable([['value'], [10], [30]], 'IDENTIFYING_SOURCE');
renamed.promptName = 'safe_records';
for (const build of [t => buildDescriptorPrompt([t]), t => buildPrompt([t], context)]) {
    assert.match(build(renamed), /"name": "safe_records"/);
    assert.ok(!build(renamed).includes('IDENTIFYING_SOURCE'));
    renamed.promptName = '   ';
    assert.match(build(renamed), /"name": "table_1"/);
    assert.ok(!build(renamed).includes('IDENTIFYING_SOURCE'));
    renamed.promptName = 'safe_records';
}
console.log('Both prompt phases export replacement table names and fall back to aliases when cleared.');
