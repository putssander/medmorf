// anonymize-excel-stats.js — pure helpers for Anonymize on .xlsx sheets.
// The selected text cells are joined into one text (one detection pass, one
// review index). These helpers remember where each cell sits in that text so
// detections can be traced back to sheet rows and columns: run statistics
// (rows / cells with PII, per column, per type) and a preview limited to the
// rows that contain PII. No DOM, no models: tested in tests/test-anonymize-excel-stats.mjs.

export const EXCEL_CELL_SEPARATOR = '\n---\n';

// Column index → spreadsheet letters (0 → A, 25 → Z, 26 → AA).
export function columnLetter(index) {
    let n = index + 1, out = '';
    while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
    return out;
}

// `matrix` is sheet_to_json(ws, { header: 1, defval: '' }) (row 0 = header).
// `origin` is the sheet's top-left cell ({ r, c }, zero-based) so row numbers
// and column letters match what the user sees in Excel.
export function buildExcelCellIndex(matrix, selectedCols, origin = { r: 0, c: 0 }) {
    const header = matrix[0] || [];
    const parts = [];
    const cells = [];
    let offset = 0;
    for (let i = 1; i < matrix.length; i++) {
        const row = matrix[i] || [];
        for (const col of selectedCols) {
            const value = row[col];
            if (!value || typeof value !== 'string' || !value.trim()) continue;
            if (parts.length) offset += EXCEL_CELL_SEPARATOR.length;
            cells.push({ start: offset, end: offset + value.length, row: origin.r + i + 1, col });
            parts.push(value);
            offset += value.length;
        }
    }
    const columns = {};
    for (const col of selectedCols) {
        const name = String(header[col] ?? '').trim();
        columns[col] = { name: name || `Column ${columnLetter(origin.c + col)}`, letter: columnLetter(origin.c + col) };
    }
    return { text: parts.join(EXCEL_CELL_SEPARATOR), cells, columns, dataRows: Math.max(0, matrix.length - 1) };
}

// `spans` are sorted, non-overlapping { start, end, type, disabled } over the
// joined text (computeEntitySpans with includeDisabled). Enabled spans are
// what the download replaces; disabled ones are only shown greyed.
// Returns counts plus `rows`: every row with at least one enabled span, in
// sheet order, with the cells (and span indices) to show in the preview.
export function summarizeExcelSpans(index, spans) {
    const { cells } = index;
    const byCell = new Map(); // cell index → { enabled, spans: [span index…] }
    const spanCell = new Int32Array(spans.length).fill(-1); // span index → cell index
    let c = 0;
    spans.forEach((span, i) => {
        while (c < cells.length && cells[c].end <= span.start) c++;
        if (c >= cells.length || span.start < cells[c].start) return; // inside a separator: cannot happen for real entities
        let entry = byCell.get(c);
        if (!entry) { entry = { enabled: 0, spans: [] }; byCell.set(c, entry); }
        entry.spans.push(i);
        spanCell[i] = c;
        if (!span.disabled) entry.enabled++;
    });
    const perType = {};
    let occurrences = 0;
    for (const span of spans) {
        if (span.disabled) continue;
        occurrences++;
        perType[span.type] = (perType[span.type] || 0) + 1;
    }
    const perColumn = {};
    for (const col of Object.keys(index.columns)) perColumn[col] = { cells: 0, rows: new Set() };
    const rowMap = new Map();
    let cellsWithPii = 0;
    for (const [cellIndex, entry] of byCell) {
        if (!entry.enabled) continue;
        const cell = cells[cellIndex];
        cellsWithPii++;
        const column = perColumn[cell.col] || (perColumn[cell.col] = { cells: 0, rows: new Set() });
        column.cells++;
        column.rows.add(cell.row);
        let row = rowMap.get(cell.row);
        if (!row) { row = { row: cell.row, cells: [] }; rowMap.set(cell.row, row); }
        row.cells.push({ cellIndex, spans: entry.spans });
    }
    const rows = [...rowMap.values()].sort((a, b) => a.row - b.row);
    rows.forEach(r => r.cells.sort((a, b) => a.cellIndex - b.cellIndex));
    const rowsWithText = new Set(cells.map(cell => cell.row)).size;
    return {
        dataRows: index.dataRows,
        rowsWithText,
        textCells: cells.length,
        rowsWithPii: rows.length,
        cellsWithPii,
        occurrences,
        perType,
        perColumn: Object.entries(perColumn).map(([col, v]) => ({ col: Number(col), ...index.columns[col], cells: v.cells, rows: v.rows.size })),
        rows,
        spanCell,
        spansOfCell: (cellIndex) => byCell.get(cellIndex)?.spans || [],
    };
}
