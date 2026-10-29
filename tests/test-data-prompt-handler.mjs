// Lightweight DOM contract test: exercises actual handler events without a GPU/download.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
class Element {
    value = ''; checked = false; disabled = false; children = []; listeners = {}; textContent = '';
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelector(selector) { return selector === 'input' ? this.children.at(-1) : null; }
    setAttribute() {}
    click() {}
}
const nodes = new Map();
const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
globalThis.document = { getElementById: get, createElement: () => new Element() };
globalThis.window = {};
get('dpFormat').value = 'CSV';
let source = await readFile(new URL('../src/data-prompt-handler.js', import.meta.url), 'utf8');
source = source.replace("'./data-profile.js?v=dev-unstamped'", JSON.stringify(new URL('../src/data-profile.js', import.meta.url).href));
source = source.replace(/import \{ preflightWarn, withHeavyLoadLock \} from [^;]+;/, 'const preflightWarn = async () => Boolean(globalThis.testAllowModel); const withHeavyLoadLock = async (_, fn) => fn();');
source = source.replace("await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/lib/index.js')", '({ CreateMLCEngine: globalThis.testCreateEngine })');
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const file = { name: 'private.json', size: 100, text: async () => JSON.stringify([{ patient: 'Alice', age: 30 }, { patient: 'Bob', age: 40 }]) };
await get('dpFiles').onchange({ target: { files: [file] } });
assert.match(get('dpStatus').textContent, /1 tables prepared/);
assert.equal(get('dpTables').children.length, 1);
assert.equal(get('dpExplore').hidden, false);
assert.equal(get('dpBrief').hidden, true);
assert.equal(get('dpExport').hidden, false);
assert.ok(window.medmorfDataPromptData.hasData());
assert.match(get('dpPrompt').value, /patient/);
assert.ok(!get('dpPrompt').value.includes('Alice'));
assert.equal(get('dpCopy').disabled, true);
const tableNameInput = get('dpTables').children[0].children[4].children[0].children[1].querySelector('input');
assert.equal(tableNameInput.value, 'private');
assert.match(get('dpPrompt').value, /"name": "private"/);
tableNameInput.value = 'records'; tableNameInput.listeners.input();
assert.match(get('dpPrompt').value, /"name": "records"/);
assert.ok(!get('dpPrompt').value.includes('private'));
tableNameInput.value = ''; tableNameInput.listeners.input();
assert.match(get('dpPrompt').value, /"name": "table_1"/);
assert.ok(!get('dpPrompt').value.includes('private'));
get('dpReviewed').checked = true;
get('dpReviewed').onchange();
assert.equal(get('dpCopy').disabled, false); // Phase 1 can be copied without AI.
get('dpPrompt').listeners.input();
assert.equal(get('dpReviewed').checked, false);
assert.equal(get('dpSave').disabled, true);
get('dpPhase').value = 'detailed'; get('dpPhase').listeners.change();
get('dpPurpose').value = 'Testing';
get('dpPurpose').listeners.input();
assert.match(get('dpPrompt').value, /Purpose and population: Testing/);
await get('dpAI').onclick();
assert.match(get('dpStatus').textContent, /WebGPU unavailable/);
window.medmorfDataPromptData.clearAll();
assert.equal(get('dpPrompt').value, '');
assert.equal(get('dpTables').children.length, 0);
assert.equal(window.medmorfDataPromptData.hasData(), false);
await get('dpFiles').onchange({ target: { files: [{ name: 'bad.json', size: 10, text: async () => '[{"nested":{}}]' }] } });
assert.match(get('dpStatus').textContent, /Only flat objects/);
// A slow file read must not repopulate the UI after sensitive-state cleanup.
let finish;
const pending = get('dpFiles').onchange({ target: { files: [{ name: 'slow.json', size: 10, text: () => new Promise(resolve => { finish = resolve; }) }] } });
window.medmorfDataPromptData.clearAll();
finish('[{"x":1}]');
await pending;
assert.equal(get('dpPrompt').value, '');
assert.equal(window.medmorfDataPromptData.hasData(), false);
console.log('Handler import, JSON analysis, review reset, missing WebGPU, invalid input and cleanup race passed.');
// Folder entries remain distinct even when filenames match across subdirectories.
await get('dpFolder').onchange({ target: { files: [
    { ...file, webkitRelativePath: 'dataset/people/private.json' },
    { ...file, webkitRelativePath: 'dataset/visits/private.json' },
] } });
assert.equal(get('dpTables').children.length, 2);
assert.match(get('dpTables').children[0].children[0].textContent, /dataset\/people/);
assert.match(get('dpTables').children[1].children[0].textContent, /dataset\/visits/);
assert.match(get('dpMissing').textContent, /file_1: file purpose/);
assert.match(get('dpMissing').textContent, /file_2: file purpose/);
get('dpPhase').value = 'detailed'; get('dpPhase').listeners.change();
const descriptionInput = get('dpTables').children[0].children[3].children[0];
descriptionInput.value = 'One fictional outpatient per row.';
descriptionInput.listeners.input();
assert.match(get('dpPrompt').value, /One fictional outpatient per row/);
assert.ok(!get('dpPrompt').value.includes('dataset/people'));
assert.ok(!get('dpPrompt').value.includes('private.json'));
assert.ok(!get('dpMissing').textContent.includes('file_1: file purpose'));
assert.ok(get('dpMissing').textContent.includes('file_2: file purpose'));
// All sheets of one workbook share one file description and file alias.
window.XLSX = {
    read: () => ({ SheetNames: ['People', 'Visits'], Sheets: { People: {}, Visits: {} } }),
    utils: { sheet_to_json: () => [['number'], [1]] },
};
await get('dpFiles').onchange({ target: { files: [{ name: 'workbook.xlsx', size: 100, arrayBuffer: async () => new ArrayBuffer(0) }] } });
assert.equal(get('dpTables').children.length, 1);
assert.match(get('dpStatus').textContent, /1 files \/ 2 tables/);
assert.match(get('dpPrompt').value, /"name": "People"/);
assert.match(get('dpPrompt').value, /"name": "Visits"/);
assert.ok(!get('dpPrompt').value.includes('workbook'));
assert.equal((get('dpMissing').textContent.match(/file_1: file purpose/g) || []).length, 1);
get('dpPhase').value = 'detailed'; get('dpPhase').listeners.change();
const workbookDescription = get('dpTables').children[0].children[3].children[0];
workbookDescription.value = 'Patient and visit records for testing.';
workbookDescription.listeners.input();
assert.equal((get('dpPrompt').value.match(/Patient and visit records for testing/g) || []).length, 2);
window.medmorfDataPromptData.clearAll();
assert.equal(get('dpTables').children.length, 0);
console.log('Folder descriptions, duplicate filenames, export privacy and multi-sheet grouping passed.');

// Exercise the complete assistant flow with a deterministic fake local engine.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {}, userAgent: 'Desktop', platform: 'Linux', maxTouchPoints: 0 } });
globalThis.testAllowModel = true;
let replies = [], unloaded = 0, requests = [], stopOnNextRequest = false, failProbe = false, planGroups = null;
let planRequests = [];
globalThis.testCreateEngine = async (_model, options) => {
    options.initProgressCallback({ text: 'Cached model ready' });
    return { chat: { completions: { create: async (request) => { const input = JSON.parse(request.messages[1].content); if (input.diagnosticProbe) { assert.equal(request.response_format.type, 'json_object'); return { choices: [{message: {content: JSON.stringify(failProbe ? {} : input.expected)}}] }; } if (input.planColumns) { planRequests.push(request); return {choices:[{message:{content:JSON.stringify({groups: planGroups || [{columns:input.planColumns.map(c=>c.alias),reason:'Fictional related context; confirm dependencies'}]})}}]}; } requests.push(request); if (stopOnNextRequest) { stopOnNextRequest = false; get('dpAIStop').onclick(); } assert.equal(request.extra_body.enable_thinking, false); assert.ok([350, 600, 700, 900, 1200, 1800].includes(request.max_tokens)); assert.equal(request.response_format.type, 'json_object'); assert.equal(JSON.parse(request.response_format.schema).additionalProperties, false); assert.equal(get('dpExplore').hidden, false); assert.equal(get('dpBrief').hidden, get('dpPhase').value !== 'detailed'); assert.equal(get('dpExport').hidden, false); const next = replies.shift(); if (next instanceof Error) throw next; if (input.requireExamples && Array.isArray(next?.columns)) for (const c of next.columns) { if (!c.syntheticExamples) c.syntheticExamples = input.columns.find(col => col.alias === c.alias)?.type === 'number' ? [31,32,33] : ['Fictional amber','Fictional blue','Fictional green']; } return { choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }; } } }, unload: async () => { unloaded++; } };
};
await get('dpFiles').onchange({ target: { files: [file] } });
replies = [
    { description: 'Tentative patient summary table' },
    { columns: [{ alias: 'column_1', semanticRole: 'free_text', description: 'Fictional person label', units: 'unitless', rules: 'No real people' }, { alias: 'column_2', semanticRole: 'measurement', description: 'Tentative age', units: 'years', rules: 'Confirm ranges' }] },
    { purpose: 'Suggested software testing dataset', relationships: 'Confirm whether rows are independent', count: 750, format: 'JSON' },
];
await get('dpAI').onclick();
assert.equal(get('dpExplore').hidden, false);
assert.equal(get('dpBrief').hidden, false);
assert.equal(get('dpExport').hidden, false);
assert.equal(get('dpPurpose').value, 'Suggested software testing dataset');
assert.equal(get('dpCount').value, '750');
assert.equal(get('dpFormat').value, 'JSON');
assert.match(get('dpRelationships').value, /Confirm/);
assert.match(get('dpAIActivity').textContent, /fields drafted/);
assert.equal(get('dpAIProgress').value, get('dpAIProgress').max);
assert.match(get('dpStageBrief').textContent, /✓/);
assert.equal(get('dpReviewed').checked, false);
assert.equal(unloaded, 1);
// Names repaint immediately; rapid switches coalesce the expensive prompt update.
const sheet = get('dpTables').children[0].children[4];
const columnRow = sheet.children[1].children[0].children[2].children[0];
const nameToggle = columnRow.children[5].children[0].querySelector('input');
const statsToggle = columnRow.children[5].children[1].querySelector('input');
const previewPanel = sheet.children[2];
const previewHeader = () => previewPanel.children[2].children[0].children[0].children[0].children[0].textContent;
assert.equal(previewHeader(), 'patient');
let promptWrites = 0, savedPrompt = get('dpPrompt').value;
Object.defineProperty(get('dpPrompt'), 'value', { configurable: true, get: () => savedPrompt, set: value => { promptWrites++; savedPrompt = value; } });
get('dpReviewed').checked = true; get('dpReviewed').onchange();
nameToggle.checked = false; nameToggle.listeners.input();
assert.equal(previewHeader(), 'column_1');
assert.equal(get('dpReviewed').checked, false);
assert.equal(get('dpCopy').disabled, true);
statsToggle.checked = true; statsToggle.listeners.input();
nameToggle.checked = true; nameToggle.listeners.input();
assert.equal(previewHeader(), 'patient');
assert.equal(promptWrites, 0);
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(promptWrites, 1);
assert.equal(get('dpTables').children[0].children[4], sheet);
assert.match(get('dpPrompt').value, /"name": "patient"/);
// Checking review during a pending update flushes it and still requires fresh review.
nameToggle.checked = false; nameToggle.listeners.input();
get('dpReviewed').checked = true; get('dpReviewed').onchange();
assert.equal(get('dpReviewed').checked, false);
assert.equal(get('dpSave').disabled, true);
assert.match(get('dpPrompt').value, /"name": "column_1"/);
nameToggle.checked = true; nameToggle.listeners.input();
await new Promise(resolve => setTimeout(resolve, 150));
console.log('Example headers follow toggles immediately; rapid toggles batch prompt writes and invalidate approval.');
const enrichedPrompt = get('dpPrompt').value;
assert.match(enrichedPrompt, /Suggested software testing dataset/);
get('dpPhase').value = 'descriptors'; get('dpPhase').listeners.change();
assert.equal(get('dpBrief').hidden, true);
assert.match(get('dpPrompt').value, /Phase 1 only/);
assert.ok(!get('dpPrompt').value.includes('Suggested software testing dataset'));
assert.ok(!get('dpPrompt').value.includes('Tentative patient summary table'));
get('dpReviewed').checked = true; get('dpReviewed').onchange();
assert.equal(get('dpSave').disabled, false);
get('dpPhase').value = 'detailed'; get('dpPhase').listeners.change();
assert.equal(get('dpPrompt').value, enrichedPrompt);
assert.equal(get('dpReviewed').checked, false);
assert.equal(get('dpSave').disabled, true);
get('dpPurpose').value = 'My own purpose'; get('dpPurpose').listeners.input();
get('dpCount').value = '17'; get('dpCount').listeners.input();
get('dpFormat').value = 'CSV'; get('dpFormat').listeners.input();
replies = [{ description: 'Updated file draft' }, { columns: [{ alias: 'column_1', semanticRole: 'free_text', description: 'Fictional label', units: 'unitless', rules: 'No real people' }, { alias: 'column_2', semanticRole: 'measurement', description: 'Age', units: 'years', rules: 'Confirm ranges' }] }, { purpose: 'Overwrite attempt', relationships: 'Updated relationship draft', count: 200, format: 'JSON' }];
await get('dpAI').onclick();
assert.equal(get('dpPurpose').value, 'My own purpose');
assert.equal(get('dpCount').value, '17');
assert.equal(get('dpFormat').value, 'CSV');
assert.equal(get('dpRelationships').value, 'Updated relationship draft');
assert.equal(unloaded, 2);
window.medmorfDataPromptData.clearAll();
console.log('Mocked AI flow: generated brief, row count/format suggestions, stage progress, review reset and manual-edit preservation passed.');

// Repeated incomplete replies must never expose a partial result.
await get('dpFiles').onchange({ target: { files: [file] } });
requests = [];
replies = Array(6).fill({});
await get('dpAI').onclick();
for (const id of ['dpExplore', 'dpExport']) assert.equal(get(id).hidden, false);
for (const id of ['dpBrief', 'dpMissingPanel']) assert.equal(get(id).hidden, true);
assert.match(get('dpAIActivity').textContent, /Stopped early/);
get('dpReviewed').checked = true; get('dpReviewed').onchange();
assert.equal(get('dpSave').disabled, false);
assert.match(get('dpPrompt').value, /Phase 1 only/);
get('dpReviewed').checked = false; get('dpReviewed').onchange();
assert.equal(requests.length, 4); // Two tasks, each with one retry; no further fan-out.
assert.equal(get('dpSave').disabled, true);
window.medmorfDataPromptData.clearAll();
assert.equal(get('dpExplore').hidden, true);
console.log('Phase 1 remains visible and exportable after failed AI; cleanup hides results.');

await get('dpFiles').onchange({ target: { files: [file] } });
requests = [];
replies = [
    {description: 'Tentative table'},
    {columns: [
        {alias: 'column_1', semanticRole: 'free_text', description: 'Fictional label', units: 'unitless', rules: 'Avoid real people'},
        {alias: 'column_2', semanticRole: 'measurement', description: 'Tentative age', rules: 'Confirm range'}
    ]},
    {columns: [{alias: 'column_2', units: 'years'}]},
    {purpose:'Suggested tests', relationships:'Confirm links', count:100, format:'CSV'},
];
await get('dpAI').onclick();
assert.equal(requests.length, 4);
assert.deepEqual(JSON.parse(requests[2].messages[1].content).columns.map(c => c.alias), ['column_1', 'column_2']);
assert.match(requests[2].messages[0].content, /column_2.units/);
assert.equal(get('dpExplore').hidden, false);
assert.match(get('dpPrompt').value, /Tentative age/);
assert.match(get('dpPrompt').value, /years/);
window.medmorfDataPromptData.clearAll();
console.log('Partial model responses retain valid fields and retry only affected columns with specific feedback.');

// File drafts and validated grouping plans must be reused on retry.
planRequests = [];
await get('dpFiles').onchange({ target: { files: [file] } });
requests = [];
replies = [{description:'Cached file understanding'}, {}, {}, {}, {}];
await get('dpAI').onclick();
assert.equal(requests.length, 5);
assert.match(get('dpAIActivity').textContent, /1 completed tasks kept/);
assert.equal(get('dpExplore').hidden, false);
requests = [];
replies = [
    {columns:[{alias:'column_1',semanticRole:'free_text',description:'Fictional label',units:'not applicable',rules:'Invent labels'}, {alias:'column_2',semanticRole:'measurement',description:'Tentative age',units:'years',rules:'Confirm bounds'}]},
    {purpose:'Testing',relationships:'Confirm links',count:100,format:'CSV'}
];
await get('dpAI').onclick();
assert.equal(requests.length, 2);
assert.ok(!JSON.parse(requests[0].messages[1].content).file);
assert.equal(get('dpExplore').hidden, false);
assert.match(get('dpPrompt').value, /Cached file understanding/);
assert.equal(planRequests.length, 1); // Retry did not ask the model to regroup columns.
window.medmorfDataPromptData.clearAll();
// Reproduce a large all-failing folder: only its first two tasks may run.
await get('dpFiles').onchange({target:{files:Array.from({length:8},(_,i)=>({...file,name:`file-${i}.json`}))}});
requests = []; replies = Array(54).fill({});
await get('dpAI').onclick();
assert.equal(requests.length, 4);
assert.equal(get('dpAIStop').hidden, true);
window.medmorfDataPromptData.clearAll();
console.log('Schema mode, fail-fast on an eight-file folder, and completed-task reuse on retry passed.');

await get('dpFiles').onchange({target:{files:[file]}});
requests=[]; replies=[{description:'Should not be applied'}]; stopOnNextRequest=true;
await get('dpAI').onclick();
assert.equal(requests.length,1);
assert.match(get('dpAIActivity').textContent,/Stopped by you/);
assert.equal(get('dpExplore').hidden,false);
assert.equal(get('dpAIStop').hidden,true);
window.medmorfDataPromptData.clearAll();
console.log('Stop action prevents later inference tasks and preserves Phase 1.');

// Related columns stay together when repairing malformed responses.
await get('dpFiles').onchange({target:{files:[file]}});
requests=[];
replies=[
 {description:'File draft'}, 'not JSON',
 {columns:[{alias:'column_1',semanticRole:'free_text',description:'Label',units:'unitless',rules:'Invent labels'}, {alias:'column_2',semanticRole:'measurement',description:'Age',units:'years',rules:'Confirm bounds'}]},
 {purpose:'Testing',relationships:'Confirm links',count:100,format:'CSV'}
];
await get('dpAI').onclick();
assert.equal(requests.length,4);
assert.equal(JSON.parse(requests[1].messages[1].content).columns.length,2);
assert.equal(JSON.parse(requests[2].messages[1].content).columns.length,2);
assert.equal(JSON.parse(requests[2].messages[1].content).analysisMode,'combined');
assert.equal(get('dpExplore').hidden,false);
assert.ok(!get('dpAIDiagnostics').value.includes('Alice'));
assert.ok(!get('dpAIDiagnostics').value.includes('not JSON'));
window.medmorfDataPromptData.clearAll();
// A broken runtime must fail its fictional check before any dataset call.
await get('dpFiles').onchange({target:{files:[file]}});
failProbe=true; requests=[];
await get('dpAI').onclick();
assert.equal(requests.length,0);
assert.match(get('dpAIActivity').textContent,/failed a two-column fictional format check/);
assert.equal(get('dpExplore').hidden,false);
assert.equal(get('dpAIStop').hidden,true);
failProbe=false;
window.medmorfDataPromptData.clearAll();
console.log('Fictional preflight stops broken inference; related groups stay together on repair; diagnostics omit content.');

// Bulk export controls affect one table, track mixed selection, and reset approval.
await get('dpFiles').onchange({ target: { files: [{ ...file, name: 'a.json' }, { ...file, name: 'b.json' }] } });
const firstGrid = get('dpTables').children[0].children[4].children[1].children[0];
const secondGrid = get('dpTables').children[1].children[4].children[1].children[0];
const masters = grid => grid.children[1].children[0].children[5].children.map(label => label.querySelector('input'));
const rowSwitches = grid => grid.children[2].children.map(row => row.children[5].children.map(label => label.querySelector('input')));
const [allNames, allStats] = masters(firstGrid);
assert.equal(allNames.checked, true);
assert.equal(allStats.checked, true);
const oneName = rowSwitches(firstGrid)[0][0];
oneName.checked = false; oneName.listeners.input();
assert.equal(allNames.indeterminate, true);
allNames.checked = true; allNames.listeners.input();
assert.equal(allNames.indeterminate, false);
assert.ok(rowSwitches(firstGrid).every(([name]) => name.checked));
await new Promise(resolve => setTimeout(resolve, 150));
get('dpReviewed').checked = true; get('dpReviewed').onchange();
allNames.checked = false; allNames.listeners.input();
allStats.checked = false; allStats.listeners.input();
assert.equal(get('dpSave').disabled, true);
assert.ok(rowSwitches(firstGrid).every(([name, stats]) => !name.checked && !stats.checked));
assert.ok(rowSwitches(secondGrid).every(([name, stats]) => name.checked && stats.checked));
await new Promise(resolve => setTimeout(resolve, 150));
const bulkSchema = JSON.parse(get('dpPrompt').value.split('Dataset descriptors:\n')[1].split('\n\nTreat all headers')[0]);
assert.deepEqual(bulkSchema[0].columns.map(c => c.name), ['column_1', 'column_2']);
assert.ok(bulkSchema[0].columns.every(c => c.statistics === 'Withheld by user'));
assert.deepEqual(bulkSchema[1].columns.map(c => c.name), ['patient', 'age']);
assert.equal(bulkSchema[1].columns[1].statistics.mean, 35);
allStats.checked = true; allStats.listeners.input();
assert.ok(rowSwitches(firstGrid).every(([, stats]) => stats.checked));
assert.equal(get('dpAllStatistics').checked, true);
get('dpAllStatistics').checked = false; get('dpAllStatistics').listeners.input();
for (const grid of [firstGrid, secondGrid]) {
    assert.ok(rowSwitches(grid).every(([, stats]) => !stats.checked));
    assert.equal(masters(grid)[1].checked, false);
    assert.equal(masters(grid)[1].indeterminate, false);
}
assert.equal(get('dpTables').children[0].children[4].children[1].children[0], firstGrid);
assert.equal(get('dpSave').disabled, true);
await new Promise(resolve => setTimeout(resolve, 150));
assert.ok(!get('dpPrompt').value.includes('"mean"'));
assert.match(get('dpPrompt').value, /"name": "patient"/);
get('dpPhase').value = 'detailed'; get('dpPhase').listeners.change();
assert.ok(!get('dpPrompt').value.includes('"mean"'));
const singleStatistic = rowSwitches(firstGrid)[0][1];
singleStatistic.checked = true; singleStatistic.listeners.input();
assert.equal(get('dpAllStatistics').indeterminate, true);
assert.equal(get('dpAllStatistics').checked, false);
get('dpAllStatistics').checked = true; get('dpAllStatistics').listeners.input();
assert.equal(get('dpAllStatistics').indeterminate, false);
assert.ok(rowSwitches(secondGrid).every(([, stats]) => stats.checked));
await new Promise(resolve => setTimeout(resolve, 150));
assert.match(get('dpPrompt').value, /"mean": 35/);
window.medmorfDataPromptData.clearAll();
assert.equal(get('dpAllStatistics').disabled, true);
assert.equal(get('dpAllStatistics').checked, false);
console.log('Per-table bulk name/statistics switches, mixed state, table isolation and exported scope passed.');
console.log('Analysis-wide statistics switch updates all tables in place, supports both phases and tracks individual overrides.');

// The model plan determines requests; a copied example is repaired before application.
const semanticFile = { name: 'categories.json', size: 500, text: async () => JSON.stringify([
    { country_of_birth: 'USA', product_code: 'old-a', product_label: 'Old amber' },
    { country_of_birth: 'MEX', product_code: 'old-b', product_label: 'Old blue' },
    { country_of_birth: 'DEU', product_code: 'old-c', product_label: 'Old green' },
]) };
await get('dpFiles').onchange({ target: { files: [semanticFile] } });
requests = []; planRequests = [];
planGroups = [{ columns: ['column_1'], reason: 'Self-contained category' }, { columns: ['column_2', 'column_3'], reason: 'Code and label must correspond' }];
const draftColumn = (alias, syntheticExamples) => ({ alias, semanticRole: 'category', description: 'Fictional category', units: 'unitless', rules: 'Use meaningful alternatives', syntheticExamples });
replies = [
    { description: 'Fictional category records' },
    { columns: [draftColumn('column_1', ['USA', 'FRA', 'ESP'])] },
    { columns: [draftColumn('column_1', ['CAN', 'FRA', 'ESP'])] },
    { columns: [draftColumn('column_2', ['new-a', 'new-b', 'new-c']), draftColumn('column_3', ['New amber', 'New blue', 'New green'])] },
    { purpose: 'Fictional testing', relationships: 'Code and label correspond; confirm semantics', count: 100, format: 'JSON' },
];
await get('dpAI').onclick();
assert.equal(planRequests.length, 1);
assert.match(planRequests[0].messages[0].content, /smallest set/);
assert.ok(JSON.parse(planRequests[0].messages[1].content).planColumns.every(c => c.samples.length <= 2));
assert.equal(requests.length, 5);
assert.deepEqual(requests.slice(1, 4).map(r => JSON.parse(r.messages[1].content).columns.length), [1, 1, 2]);
assert.match(requests[2].messages[0].content, /source column/);
assert.equal(JSON.parse(requests[3].messages[1].content).analysisMode, 'combined');
const semanticPreview = get('dpTables').children[0].children[4].children[2];
const exampleRows = semanticPreview.children[2].children[0].children[1].children;
assert.deepEqual(exampleRows.map(row => row.children.map(cell => cell.textContent)), [['CAN','new-a','New amber'], ['FRA','new-b','New blue'], ['ESP','new-c','New green']]);
planGroups = null;
window.medmorfDataPromptData.clearAll();
console.log('Model-planned singleton and pair requests, novel semantic examples, copied-value repair and aligned rows passed.');

// A timeout after successful tasks stops immediately; retry keeps both tasks and plan.
window.medmorfDataPromptData.clearAll();
await get('dpFiles').onchange({target:{files:[file]}});
requests=[]; planRequests=[];
planGroups=[{columns:['column_1'],reason:'Independent label'}, {columns:['column_2'],reason:'Independent age'}];
const timeoutError=Object.assign(new Error('no generation progress for 90 seconds; generation interrupted'), {code:'DRAFT_TIMEOUT'});
replies=[
    {description:'Retained file description'},
    {columns:[{alias:'column_1',semanticRole:'free_text',description:'Retained label meaning',units:'not applicable',rules:'Invent labels'}]},
    timeoutError,
];
await get('dpAI').onclick();
assert.equal(requests.length,3);
assert.match(get('dpAIActivity').textContent,/Paused after a local inference timeout/);
assert.match(get('dpAIActivity').textContent,/2 completed tasks kept/);
assert.doesNotMatch(get('dpAIActivity').textContent,/repeated model failures|45 seconds/);
assert.match(get('dpAI').textContent,/Resume Phase 2.*2 tasks retained/);
assert.equal(get('dpPhase').value,'descriptors');
// A different proposed plan must not affect resume: no planning call should occur.
planGroups=[{columns:['column_1','column_2'],reason:'Should never be requested'}];
requests=[];
replies=[
    {columns:[{alias:'column_2',semanticRole:'measurement',description:'Age',units:'years',rules:'Respect bounds'}]},
    {purpose:'Testing',relationships:'Confirm links',count:100,format:'CSV'},
];
await get('dpAI').onclick();
assert.equal(planRequests.length,1);
assert.equal(requests.length,2);
assert.deepEqual(JSON.parse(requests[0].messages[1].content).columns.map(c=>c.alias),['column_2']);
assert.equal(get('dpPhase').value,'detailed');
assert.match(get('dpPrompt').value,/Retained label meaning/);
assert.match(get('dpPrompt').value,/Retained file description/);
assert.equal(get('dpAI').textContent,'Run optional Phase 2');
window.medmorfDataPromptData.clearAll();
console.log('Timeout wording, immediate stop, retained-task resume and stable cached grouping passed.');
