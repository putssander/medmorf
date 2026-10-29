import assert from 'node:assert/strict';
import { parseDraftJSON, applyColumnDrafts, applyFileDraft, briefDraft } from '../src/data-prompt-drafts.js';
import { profileTable, configureIdentifier, syntheticPreview, buildPrompt } from '../src/data-profile.js';
assert.deepEqual(parseDraftJSON('```json\n{"columns":[]}\n```'), { columns: [] });
for (const value of ['not JSON', 'null', '[]', 'x'.repeat(50001)]) assert.throws(() => parseDraftJSON(value));
const table = profileTable([['id', 'age'], ['AA-000001', 20], ['AA-000002', 60]], 'data');
table.columns[1].description = 'User-written meaning';
table.columns[1].units = 'years';
const before = JSON.stringify(table.columns[1].stats);
const count = applyColumnDrafts(table, { columns: [
    { alias: 'column_1', description: 'Tentative record identifier', units: 'unitless', rules: 'Use new fictional IDs', identifierFormat: 'AA-999999', share: true, shareName: true, source: 'changed' },
    { alias: 'column_2', description: 'Overwrite attempt', units: 'months', rules: 'Confirm plausible range', stats: { min: -1 } },
    { alias: 'nonexistent', description: 'Ignored' },
]}, configureIdentifier);
assert.equal(count, 5);
assert.equal(table.columns[1].description, 'User-written meaning');
assert.equal(table.columns[1].units, 'years');
assert.equal(table.columns[1].rules, 'Confirm plausible range');
assert.equal(JSON.stringify(table.columns[1].stats), before);
assert.equal(table.columns[0].source, 'id');
assert.equal(table.columns[0].share, false);
assert.equal(table.columns[0].shareName, true);
assert.equal(table.columns[0].aiDraft, true);
assert.equal(syntheticPreview(table).rows.length, 3);
assert.equal(applyColumnDrafts(table, { columns: [{ alias: 'column_1', description: 'Improved AI draft' }] }, configureIdentifier), 1);
table.columns[0].description = 'Manual corrected meaning';
assert.equal(applyColumnDrafts(table, { columns: [{ alias: 'column_1', description: 'Do not overwrite' }] }, configureIdentifier), 0);
const other = profileTable([['id'], ['0'], ['1']], 'other');
applyColumnDrafts(other, { columns: [{ alias: 'column_1', identifierFormat: 'fixed' }] }, configureIdentifier);
assert.equal(other.columns[0].identifierFormat, '');
const file = { description: '' };
assert.equal(applyFileDraft(file, { description: 'Tentative record table' }), 1);
assert.equal(applyFileDraft(file, { description: 'Refreshed AI content summary' }), 1);
file.description = 'Manual file description';
assert.equal(applyFileDraft(file, { description: 'Overwrite attempt' }), 0);
assert.deepEqual(briefDraft({ purpose: '  Fictional tests ', relationships: 123, share: true }), { purpose: 'Fictional tests', relationships: '' });
assert.equal(briefDraft({ purpose: 'x'.repeat(2000) }).purpose.length, 1500);
table.columns[0].shareName = true;
table.columns[1].shareName = false;
const prompt = buildPrompt([table], {});
assert.ok(prompt.includes('"name": "id"'));
assert.ok(prompt.includes('"name": "column_2"'));
console.log('Structured AI drafts, preservation of edits, bounded fields, validated IDs and export-control isolation passed.');

const { getContentSamples, clearContentSamples } = await import('../src/data-profile.js');
const sampled = profileTable([['notes'], ...Array.from({length: 10}, (_, i) => [`Private record ${i} ` + 'x'.repeat(600)])], 'samples');
const snippets = getContentSamples(sampled.columns[0]);
assert.equal(snippets.length, 5);
assert.ok(snippets.every(s => s.length === 120));
assert.ok(snippets[0].startsWith('Private record 0'));
assert.ok(snippets[1].startsWith('Private record 1'));
assert.ok(snippets[4].startsWith('Private record 4'));
assert.ok(!JSON.stringify(sampled).includes('Private record'));
assert.ok(!buildPrompt([sampled], {}).includes('Private record'));
snippets[0] = 'changed';
assert.ok(getContentSamples(sampled.columns[0])[0].startsWith('Private record 0'));
clearContentSamples();
assert.deepEqual(getContentSamples(sampled.columns[0]), []);
console.log('Bounded local samples, direct-export exclusion, cleanup and AI-draft refresh with edit preservation passed.');

const { columnEvidence } = await import('../src/data-prompt-drafts.js');
assert.equal(columnEvidence('patientId', ['001', '002', '003']).candidateRole, 'identifier');
assert.equal(columnEvidence('patientId', ['001', '002', '003']).dominantCharacterFormat, '999');
assert.equal(columnEvidence('patientId', ['001', '002', '003']).leadingZeros, true);
assert.equal(columnEvidence('parent_id', ['A-1', 'A-1']).candidateRole, 'reference');
assert.equal(columnEvidence('valid', ['1', '2']).nameSuggestsIdentifier, false);
assert.equal(columnEvidence('age', ['20', '21', '22']).candidateRole, 'unknown');
assert.equal(columnEvidence('visit_date', ['2024-01-01', '2024-02-02']).candidateRole, 'datetime');
const smart = profileTable([['patient_id', 'value'], ['001', 1], ['002', 2]], 'smart');
applyColumnDrafts(smart, { columns: [{ alias: 'column_1', semanticRole: 'identifier', description: 'Record identifier', rules: 'Preserve leading zeros', units: 'unitless' }] }, configureIdentifier);
assert.equal(smart.columns[0].semanticRole, 'identifier');
assert.equal(smart.columns[0].identifierFormat, '999');
assert.deepEqual(smart.columns[0].identifierValues, ['000', '003', '004']);
smart.columns[0].semanticRole = 'category';
applyColumnDrafts(smart, { columns: [{ alias: 'column_1', semanticRole: 'identifier' }, { alias: 'column_2', semanticRole: 'invented' }] }, configureIdentifier);
assert.equal(smart.columns[0].semanticRole, 'category');
assert.equal(smart.columns[1].semanticRole, '');
console.log('Default header export, ID/role evidence, numeric-ID formats and manual role preservation passed.');

assert.deepEqual(briefDraft({ count: 500, format: 'JSON' }), { purpose: '', relationships: '', count: '500', format: 'JSON' });
for (const count of [-1, 0, 1.5, 1000001, 'not a number']) assert.equal(briefDraft({ count }).count, undefined);
assert.equal(briefDraft({ format: 'unsupported' }).format, undefined);

const { validateDraftResponse, draftGaps } = await import('../src/data-prompt-drafts.js');
assert.throws(() => validateDraftResponse({columns: []}, {columns: [{alias: 'column_1'}]}), /Missing column/);
assert.throws(() => validateDraftResponse({}, {file: 'file_1'}), /Missing file/);
assert.throws(() => validateDraftResponse({purpose:'Test'}, {currentBrief:{}}), /Incomplete/);
assert.ok(draftGaps(smart ? [smart] : [], [{alias:'file_1',description:''}], {}).length > 0);

const topFive = profileTable([['text', 'keep'], ['', 1], [null, 2], [' ', 3], ['', 4], [null, 5], ['LATER_ROW_MUST_NOT_REACH_MODEL', 6]], 'missing first rows');
assert.deepEqual(getContentSamples(topFive.columns[0]), []);
assert.equal(topFive.rows, 6); // Whole-file statistics remain accurate.
const firstRows = profileTable([['text'], ...Array.from({length: 8}, (_, i) => [`row-${i}`])], 'first rows');
assert.deepEqual(getContentSamples(firstRows.columns[0]), ['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
console.log('Strict first-five-row sampling, 120-character bounds, no backfill, and full-file row counts passed.');

const { mergeDraftResponse, draftResponseIssues } = await import('../src/data-prompt-drafts.js');
const repairPayload = {columns:[{alias:'column_1'}]};
const partial = mergeDraftResponse({}, {columns:[{alias:'column_1', semanticRole:'identifier|measurement', description:'Tentative meaning', units:'unitless', rules:'Use fictional values'}]}, repairPayload);
assert.deepEqual(draftResponseIssues(partial, repairPayload), ['column_1.semanticRole']);
const repaired = mergeDraftResponse(partial, {columns:[{alias:'column_1', semanticRole:'identifier', description:'Overwrite attempt', share:true}]}, repairPayload);
assert.equal(repaired.columns[0].description, 'Tentative meaning');
assert.equal(repaired.columns[0].share, undefined);
assert.deepEqual(draftResponseIssues(repaired, repairPayload), []);

const {draftResponseFormat} = await import('../src/data-prompt-drafts.js');
const columnSchema = JSON.parse(draftResponseFormat({columns:[{alias:'column_1'},{alias:'column_2'}]}).schema);
assert.equal(columnSchema.additionalProperties, false);
assert.deepEqual(columnSchema.required, ['columns']);
assert.equal(columnSchema.properties.columns.minItems, 2);
assert.equal(columnSchema.properties.columns.maxItems, 2);
assert.deepEqual(columnSchema.properties.columns.items.properties.alias.enum, ['column_1','column_2']);
assert.ok(columnSchema.properties.columns.items.required.includes('rules'));
assert.ok(columnSchema.properties.columns.items.properties.semanticRole.enum.includes('identifier'));
assert.deepEqual(JSON.parse(draftResponseFormat({file:'file_1'}).schema).required, ['description']);
assert.deepEqual(JSON.parse(draftResponseFormat({currentBrief:{}}).schema).required, ['purpose','relationships','count','format']);

const {runDraftInference} = await import('../src/data-prompt-drafts.js');
let interrupted = 0;
await assert.rejects(runDraftInference({chat:{completions:{create:()=>new Promise(()=>{})}}, interruptGenerate:()=>{interrupted++;}}, {}, 5), error=>error.code === 'DRAFT_TIMEOUT');
assert.equal(interrupted, 1);
assert.deepEqual(await runDraftInference({chat:{completions:{create:async()=>({ok:true})}}}, {}, 100), {ok:true});
console.log('Stalled inference is interrupted on timeout; completed requests clear their timer.');

assert.deepEqual(parseDraftJSON('<think>private reasoning {"wrong":1}</think>\n```json\n{"description":"Draft"}\n```'), {description:'Draft'});
assert.deepEqual(parseDraftJSON('</think>\n{"description":"Draft"}'), {description:'Draft'});
assert.deepEqual(parseDraftJSON('Here is the JSON: {"description":"a } brace"} End.'), {description:'a } brace'});
assert.throws(()=>parseDraftJSON('<think>{"description":"not the answer"}'));
assert.throws(()=>parseDraftJSON('{"a":{"b":1}'));
assert.throws(()=>parseDraftJSON('{"a":1} {"b":2}'));
const {draftResponseDiagnostics} = await import('../src/data-prompt-drafts.js');
const metadata = draftResponseDiagnostics({choices:[{finish_reason:'length',message:{content:'<think>Secret Person</think>{"description":"Secret Hospital"}'}}],usage:{completion_tokens:50,extra:{grammar_init_s:0}}});
assert.equal(metadata.reasoningWrapper,true);
assert.equal(metadata.parseableObject,true);
assert.equal(metadata.finish,'length');
assert.equal(metadata.grammarReported,true);
assert.ok(!JSON.stringify(metadata).includes('Secret'));
console.log('Reasoning/fence/prose wrappers, incomplete and ambiguous JSON rejection, and metadata-only diagnostics passed.');

const harmonized = profileTable([['result'], ['1.5'], ['2.5']], 'fictional');
applyColumnDrafts(harmonized, { columns: [{ alias: 'column_1', harmonization: 'Consider LOINC after confirming the specimen and units.' }] }, configureIdentifier);
assert.match(harmonized.columns[0].harmonization, /LOINC/);
assert.match(buildPrompt([harmonized], {}), /Unverified suggestion; no terminology lookup performed/);
harmonized.columns[0].harmonization = 'Manual mapping note';
applyColumnDrafts(harmonized, { columns: [{ alias: 'column_1', harmonization: 'Overwrite attempt' }] }, configureIdentifier);
assert.equal(harmonized.columns[0].harmonization, 'Manual mapping note');

// Streamed inference keeps partial text private and preserves completion metadata.
const progressEvents = [];
let streamRequest;
const streamed = await runDraftInference({chat:{completions:{create:async request=>{
    streamRequest = request;
    return (async function* () {
        yield {choices:[{delta:{content:'{"description":'}}]};
        yield {choices:[{delta:{content:'"Private fictional content"}'},finish_reason:'stop'}]};
        yield {choices:[],usage:{completion_tokens:12}};
    })();
}}}}, {max_tokens:1800}, {onProgress:event=>progressEvents.push(event)});
assert.equal(streamRequest.stream, true);
assert.deepEqual(streamRequest.stream_options, {include_usage:true});
assert.equal(streamed.choices[0].finish_reason, 'stop');
assert.equal(streamed.usage.completion_tokens, 12);
assert.equal(parseDraftJSON(streamed.choices[0].message.content).description, 'Private fictional content');
assert.equal(progressEvents[0].timeoutMs, 270000);
assert.ok(progressEvents.at(-1).characters > 0);
assert.ok(!JSON.stringify(progressEvents).includes('Private'));
for (const max_tokens of [350, 900, 1800, 10000]) {
    let budget;
    await runDraftInference({chat:{completions:{create:async()=>({ok:true})}}}, {max_tokens}, {onProgress:p=>{budget=p.timeoutMs;}});
    assert.ok(budget >= 120000 && budget <= 300000);
}
// Receiving chunks resets the idle watchdog; an empty chunk is not progress.
let idleInterrupts = 0;
const idleEngine = {chat:{completions:{create:async()=> (async function* () {
    yield {choices:[{delta:{content:'{'}}]};
    yield {choices:[{delta:{content:''}}]};
    await new Promise(()=>{});
})()}},interruptGenerate:()=>{idleInterrupts++;}};
await assert.rejects(runDraftInference(idleEngine, {}, {timeoutMs:1000,idleTimeoutMs:20}), e=>e.code==='DRAFT_TIMEOUT' && e.reason==='idle' && e.characters===1);
assert.equal(idleInterrupts, 1);
const healthyStream = await runDraftInference({chat:{completions:{create:async()=> (async function* () {
    for (let i=0;i<6;i++) {
        await new Promise(resolve=>setTimeout(resolve,20));
        yield {choices:[{delta:{content:'x'}}]};
    }
})()}}}, {}, {timeoutMs:2000,idleTimeoutMs:100});
assert.equal(healthyStream.choices[0].message.content,'xxxxxx'); // Total exceeds idle limit; progress resets it.
let totalInterrupts = 0;
const pacedEngine = {chat:{completions:{create:async()=> (async function* () {
    for (let i=0;i<20;i++) {
        await new Promise(resolve=>setTimeout(resolve,5));
        yield {choices:[{delta:{content:'x'}}]};
    }
})()}},interruptGenerate:()=>{totalInterrupts++;}};
await assert.rejects(runDraftInference(pacedEngine, {}, {timeoutMs:40,idleTimeoutMs:1000}), e=>e.code==='DRAFT_TIMEOUT' && e.reason==='total' && e.characters>0);
assert.equal(totalInterrupts, 1);
let cancellation = false, stopInterrupts = 0;
const stopEngine = {chat:{completions:{create:async()=> (async function* () {
    yield {choices:[{delta:{content:'{'}}]};
    await new Promise(()=>{});
})()}},interruptGenerate:()=>{stopInterrupts++;}};
await assert.rejects(runDraftInference(stopEngine, {}, {
    timeoutMs:2000, shouldStop:()=>cancellation,
    onProgress:p=>{if(p.characters) cancellation=true;},
}), e=>e.code==='DRAFT_CANCELLED');
assert.equal(stopInterrupts, 1);
console.log('Stream assembly, private progress, size-aware budgets, stalled streams, hard deadlines and Stop interruption passed.');
