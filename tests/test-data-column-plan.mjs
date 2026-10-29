import assert from 'node:assert/strict';
import { planColumnTasks, planIssues } from '../src/data-column-plan.js';
import { profileTable, syntheticPreview, clearIdentifierSources } from '../src/data-profile.js';
import { configureModelExamples, modelExampleIssue } from '../src/data-synthetic-preview.js?v=dev-unstamped';
import { applyColumnDrafts, draftResponseIssues, draftResponseFormat } from '../src/data-prompt-drafts.js';

const table = profileTable([
    ['country_of_birth', 'product_category', 'item_code', 'item_label'],
    ['USA', 'chair', 'old-a', 'Old amber item'],
    ['MEX', 'desk', 'old-b', 'Old blue item'],
    ['DEU', 'lamp', 'old-c', 'Old green item'],
], 'fictional');
const plan = { groups: [
    { columns: ['column_1'], reason: 'Self-contained coded category' },
    { columns: ['column_2'], reason: 'Self-contained product category' },
    { columns: ['column_3', 'column_4'], reason: 'Each code must correspond to its label' },
] };
const tasks = planColumnTasks(table, plan);
assert.deepEqual(tasks.map(t => t.columns.length), [1, 1, 2]);
assert.deepEqual(tasks.map(t => t.mode), ['individual', 'individual', 'combined']);
assert.throws(() => planColumnTasks(table, { groups: [{ columns: ['column_1', 'column_1'], reason: 'Duplicate' }] }));
assert.throws(() => planColumnTasks(table, { groups: [{ columns: ['column_999'], reason: 'Unknown' }] }));
assert.ok(planIssues({ groups: [] }, table.columns).length);
assert.ok(planIssues({ groups: [{ columns: ['column_1'], reason: '' }] }, table.columns).length);
const planSchema = JSON.parse(draftResponseFormat({ planColumns: table.columns }).schema);
assert.deepEqual(planSchema.required, ['groups']);
assert.equal(planSchema.properties.groups.items.properties.columns.maxItems, 4);

// Handwritten model replies: no domain-specific generator or embedded vocabulary.
const examples = [['CAN', 'FRA', 'ESP'], ['shelf', 'sofa', 'cabinet'], ['new-a', 'new-b', 'new-c'], ['New amber item', 'New blue item', 'New green item']];
for (const [i, c] of table.columns.entries()) configureModelExamples(c, examples[i]);
const preview = syntheticPreview(table);
assert.equal(preview.rows.length, 3);
assert.deepEqual(preview.rows.map(row => row.column_1), examples[0]);
assert.deepEqual(preview.rows.map(row => [row.column_3, row.column_4]), examples[2].map((code, i) => [code, examples[3][i]]));
assert.match(modelExampleIssue(table.columns[0], ['usa', 'FRA', 'ESP']), /source column/);
configureModelExamples(table.columns[0], ['USA', 'FRA', 'ESP']);
assert.equal(syntheticPreview(table).rows.length, 0);
configureModelExamples(table.columns[0], examples[0]);
assert.equal(syntheticPreview(table).rows.length, 3);
assert.match(modelExampleIssue(table.columns[0], ['x'.repeat(121), 'FRA', 'ESP']), /short text/);

const numeric = profileTable([['measurement'], ['01'], ['10']], 'numeric');
assert.match(modelExampleIssue(numeric.columns[0], [1, 2, 3]), /source column/);
assert.match(modelExampleIssue(numeric.columns[0], [2, 3, 11]), /range/);
assert.match(modelExampleIssue(numeric.columns[0], [2, 3, 4.5]), /type/);
assert.equal(modelExampleIssue(numeric.columns[0], [2, 3, 4]), '');
const binary = profileTable([['flag'], [0], [1]], 'binary');
assert.equal(modelExampleIssue(binary.columns[0], [0, 1, 0]), '');
const generic = profileTable([['status'], ['yes'], ['no']], 'generic');
generic.columns[0].allowGenericReuse = true;
configureModelExamples(generic.columns[0], ['yes', 'no', 'yes']);
assert.equal(syntheticPreview(generic).rows.length, 3);
generic.columns[0].allowGenericReuse = false;
assert.equal(syntheticPreview(generic).rows.length, 0);

const draft = { columns: [{ alias: 'column_1', semanticRole: 'category', description: 'Coded category', units: 'unitless', rules: 'Use plausible alternatives', syntheticExamples: examples[0] }] };
assert.deepEqual(draftResponseIssues(draft, { columns: [table.columns[0]], requireExamples: true }), []);
assert.ok(draftResponseIssues({ columns: [{ ...draft.columns[0], syntheticExamples: [] }] }, { columns: [table.columns[0]], requireExamples: true }).length);
applyColumnDrafts(table, draft, () => {});
assert.deepEqual(table.columns[0].modelExamples, examples[0]);
clearIdentifierSources();
assert.equal(syntheticPreview(table).rows.length, 0);
console.log('Minimal supplied plans, grouped row alignment, general model examples, collision/type checks, opt-out and cleanup passed. Model semantic accuracy is not tested.');
