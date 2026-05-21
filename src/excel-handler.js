// Excel Handler Module
// Handles Excel file reading, column selection, and writing

/**
 * Read Excel file and return workbook object
 * @param {File} file - The Excel file to read
 * @returns {Promise<Object>} Workbook object
 */
async function readExcelFile(file) {
    try {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        return workbook;
    } catch (error) {
        console.error('Error reading Excel file:', error);
        throw new Error('Failed to read Excel file: ' + error.message);
    }
}

/**
 * Get sheet names from workbook
 * @param {Object} workbook - XLSX workbook object
 * @returns {Array<string>} Array of sheet names
 */
function getSheetNames(workbook) {
    return workbook.SheetNames;
}

/**
 * Get column headers from a specific sheet
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @returns {Array} Array of column headers
 */
function getColumnHeaders(workbook, sheetName) {
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length === 0) {
        return [];
    }
    
    return jsonData[0];
}

/**
 * Get data from a specific sheet
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @returns {Array<Array>} 2D array of data
 */
function getSheetData(workbook, sheetName) {
    const worksheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
}

/**
 * Create a new workbook with translated data
 * @param {Array<Array>} data - 2D array of data including headers
 * @param {string} sheetName - Name for the new sheet
 * @returns {Object} New workbook object
 */
function createTranslatedWorkbook(data, sheetName) {
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    return workbook;
}

/**
 * Copy additional sheets from original workbook to translated workbook
 * @param {Object} sourceWorkbook - Original workbook
 * @param {Object} targetWorkbook - New workbook to copy sheets to
 * @param {string} excludeSheet - Sheet name to exclude (already added)
 */
function copyOtherSheets(sourceWorkbook, targetWorkbook, excludeSheet) {
    sourceWorkbook.SheetNames.forEach(sheetName => {
        if (sheetName !== excludeSheet) {
            XLSX.utils.book_append_sheet(
                targetWorkbook, 
                sourceWorkbook.Sheets[sheetName], 
                sheetName
            );
        }
    });
}

/**
 * Export workbook to file
 * @param {Object} workbook - XLSX workbook object
 * @param {string} filename - Name for the output file
 */
function exportWorkbook(workbook, filename) {
    XLSX.writeFile(workbook, filename);
}

/**
 * Get statistics about a sheet
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @returns {Object} Statistics object
 */
function getSheetStats(workbook, sheetName) {
    const data = getSheetData(workbook, sheetName);
    
    return {
        totalRows: data.length - 1, // Exclude header
        totalColumns: data.length > 0 ? data[0].length : 0,
        hasHeaders: data.length > 0,
        isEmpty: data.length <= 1 // Only header or empty
    };
}

/**
 * Validate column indices against sheet data
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @param {Array<number>} columnIndices - Array of column indices to validate
 * @returns {boolean} True if all indices are valid
 */
function validateColumnIndices(workbook, sheetName, columnIndices) {
    const headers = getColumnHeaders(workbook, sheetName);
    return columnIndices.every(idx => idx >= 0 && idx < headers.length);
}

/**
 * Count text cells in selected columns
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @param {Array<number>} columnIndices - Array of column indices
 * @returns {number} Count of non-empty text cells
 */
function countTextCells(workbook, sheetName, columnIndices) {
    const data = getSheetData(workbook, sheetName);
    let count = 0;
    
    // Skip header row
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        for (const colIdx of columnIndices) {
            const cell = row[colIdx];
            if (cell && typeof cell === 'string' && cell.trim() !== '') {
                count++;
            }
        }
    }
    
    return count;
}

/**
 * Create a preview of the data to translate
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Name of the sheet
 * @param {Array<number>} columnIndices - Array of column indices
 * @param {number} maxRows - Maximum number of rows to preview
 * @returns {Array<Object>} Array of preview objects
 */
function createPreview(workbook, sheetName, columnIndices, maxRows = 5) {
    const data = getSheetData(workbook, sheetName);
    const headers = data[0];
    const preview = [];
    
    const rowsToPreview = Math.min(maxRows, data.length - 1);
    
    for (let i = 1; i <= rowsToPreview; i++) {
        const row = data[i];
        const previewRow = {};
        
        columnIndices.forEach(colIdx => {
            const header = headers[colIdx];
            previewRow[header] = row[colIdx] || '';
        });
        
        preview.push(previewRow);
    }
    
    return preview;
}

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        readExcelFile,
        getSheetNames,
        getColumnHeaders,
        getSheetData,
        createTranslatedWorkbook,
        copyOtherSheets,
        exportWorkbook,
        getSheetStats,
        validateColumnIndices,
        countTextCells,
        createPreview
    };
}
