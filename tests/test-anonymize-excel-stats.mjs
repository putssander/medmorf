// Excel anonymize bookkeeping: cell offsets, sheet row numbers, PII-row summary.
// Run: node tests/test-anonymize-excel-stats.mjs
import assert from 'node:assert/strict';
import { buildExcelCellIndex, summarizeExcelSpans, columnLetter, EXCEL_CELL_SEPARATOR } from '../src/anonymize-excel-stats.js';

assert.equal(columnLetter(0), 'A');
assert.equal(columnLetter(25), 'Z');
assert.equal(columnLetter(26), 'AA');
assert.equal(columnLetter(701), 'ZZ');

// Header, a blank row, numeric and whitespace-only cells are skipped but keep row numbering.
const matrix = [
    ['id', 'note', 'gp'],
    [1, 'Jan Jansen visited', 'Dr. Smit'],
    ['', '', ''],
    [3, 'no identifiers here', 42],
    [4, '   ', 'Dr. Smit and Jan Jansen'],
];
const index = buildExcelCellIndex(matrix, [1, 2], { r: 2, c: 1 }); // sheet starts at B3
assert.equal(index.dataRows, 4);
assert.equal(index.cells.length, 4);
assert.deepEqual(index.cells.map(c => [c.row, c.col]), [[4, 1], [4, 2], [6, 1], [7, 2]]);
assert.deepEqual(index.columns, { 1: { name: 'note', letter: 'C' }, 2: { name: 'gp', letter: 'D' } });
assert.equal(index.text, ['Jan Jansen visited', 'Dr. Smit', 'no identifiers here', 'Dr. Smit and Jan Jansen'].join(EXCEL_CELL_SEPARATOR));
for (const cell of index.cells) assert.equal(index.text.slice(cell.start, cell.end), matrix[cell.row - 3][cell.col]);

// Spans as computeEntitySpans would return them (sorted, non-overlapping).
const find = (needle, from = 0) => index.text.indexOf(needle, from);
const spans = [];
let at = -1;
for (const [needle, type, disabled] of [['Jan Jansen', 'PERSON', false], ['Smit', 'PERSON', true]]) {
    while ((at = find(needle, at + 1)) >= 0) spans.push({ start: at, end: at + needle.length, type, disabled });
    at = -1;
}
spans.sort((a, b) => a.start - b.start);
const stats = summarizeExcelSpans(index, spans);
assert.equal(stats.rowsWithPii, 2, 'rows 4 and 7 contain an enabled entity');
assert.equal(stats.cellsWithPii, 2, 'cells with only a disabled entity are not changed');
assert.equal(stats.occurrences, 2);
assert.deepEqual(stats.perType, { PERSON: 2 });
assert.deepEqual(stats.rows.map(r => r.row), [4, 7]);
assert.equal(stats.textCells, 4);
assert.equal(stats.rowsWithText, 3);
assert.deepEqual(stats.perColumn.map(c => [c.letter, c.cells, c.rows]), [['C', 1, 1], ['D', 1, 1]]);
// Row 7's preview cell also carries the disabled "Smit" span (shown greyed).
assert.equal(stats.rows[1].cells[0].spans.length, 2);
spans.forEach((_, i) => assert.ok(stats.spanCell[i] >= 0, 'every span maps to a cell'));
assert.equal(stats.spansOfCell(1).length, 1, 'cell D4 holds only the disabled "Smit" span');
assert.deepEqual(stats.spansOfCell(2), [], 'cell C6 has no detections');

// Same answer as replacing cell by cell, which is what the download does.
const changedCells = index.cells.filter(cell => matrix[cell.row - 3][cell.col].includes('Jan Jansen')).length;
assert.equal(stats.cellsWithPii, changedCells);

// Empty selection and no detections.
const none = summarizeExcelSpans(index, []);
assert.equal(none.rowsWithPii, 0);
assert.equal(none.rows.length, 0);
assert.equal(buildExcelCellIndex([['h']], [0]).cells.length, 0);

// 20,000 rows stay fast.
const big = [['note'], ...Array.from({ length: 20000 }, (_, i) => [i % 7 === 0 ? `Patient Piet Bakker ${i}` : `routine note ${i}`])];
const t0 = performance.now();
const bigIndex = buildExcelCellIndex(big, [0]);
const bigSpans = [];
let p = -1;
while ((p = bigIndex.text.indexOf('Piet Bakker', p + 1)) >= 0) bigSpans.push({ start: p, end: p + 11, type: 'PERSON', disabled: false });
const bigStats = summarizeExcelSpans(bigIndex, bigSpans);
const ms = performance.now() - t0;
assert.equal(bigStats.rowsWithPii, Math.ceil(20000 / 7));
assert.ok(ms < 1000, `20k rows took ${ms} ms`);

console.log(`PASS: Excel cell index, row numbers and PII-row summary (20k rows in ${Math.round(ms)} ms).`);
