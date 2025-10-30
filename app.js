import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Configure transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

// Global state
let translator = null;
let currentFile = null;
let fileType = null;
let workbook = null;
let selectedSheet = null;
let selectedColumns = [];
let translatedData = null;
let startTime = null;

// DOM elements
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const translateBtn = document.getElementById('translateBtn');
const downloadBtn = document.getElementById('downloadBtn');
const modelStatus = document.getElementById('modelStatus');
const modelProgress = document.getElementById('modelProgress');
const modelStatusText = document.getElementById('modelStatusText');
const translationProgress = document.getElementById('translationProgress');
const translationProgressBar = document.getElementById('translationProgressBar');
const progressText = document.getElementById('progressText');
const progressPercentage = document.getElementById('progressPercentage');
const currentItem = document.getElementById('currentItem');
const results = document.getElementById('results');
const totalTranslated = document.getElementById('totalTranslated');
const timeTaken = document.getElementById('timeTaken');
const excelSettings = document.getElementById('excelSettings');
const sheetSelect = document.getElementById('sheetSelect');
const columnCheckboxes = document.getElementById('columnCheckboxes');
const sourceLanguage = document.getElementById('sourceLanguage');
const targetLanguage = document.getElementById('targetLanguage');

// Upload area interactions
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});
uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFileSelect(files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

// Handle file selection
async function handleFileSelect(file) {
    currentFile = file;
    fileName.textContent = file.name;
    fileInfo.style.display = 'block';
    
    const extension = file.name.split('.').pop().toLowerCase();
    fileType = extension === 'xlsx' ? 'excel' : extension === 'docx' ? 'word' : null;
    
    if (!fileType) {
        alert('Unsupported file type. Please upload .xlsx or .docx files.');
        return;
    }
    
    if (fileType === 'excel') {
        await handleExcelFile(file);
    } else {
        excelSettings.style.display = 'none';
        translateBtn.disabled = false;
    }
}

// Handle Excel file - load sheets and columns
async function handleExcelFile(file) {
    try {
        const data = await file.arrayBuffer();
        workbook = XLSX.read(data, { type: 'array' });
        
        // Populate sheet selector
        sheetSelect.innerHTML = '';
        workbook.SheetNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            sheetSelect.appendChild(option);
        });
        
        // Load first sheet by default
        await loadSheetColumns(workbook.SheetNames[0]);
        
        excelSettings.style.display = 'block';
        
        // Update columns when sheet changes
        sheetSelect.addEventListener('change', (e) => {
            loadSheetColumns(e.target.value);
        });
        
    } catch (error) {
        console.error('Error reading Excel file:', error);
        alert('Error reading Excel file: ' + error.message);
    }
}

// Load columns from selected sheet
async function loadSheetColumns(sheetName) {
    selectedSheet = sheetName;
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length === 0) {
        columnCheckboxes.innerHTML = '<p>No data found in this sheet</p>';
        translateBtn.disabled = true;
        return;
    }
    
    const headers = jsonData[0];
    columnCheckboxes.innerHTML = '';
    
    headers.forEach((header, index) => {
        const div = document.createElement('div');
        div.className = 'checkbox-item';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `col-${index}`;
        checkbox.value = index;
        checkbox.checked = typeof header === 'string'; // Auto-select text columns
        
        const label = document.createElement('label');
        label.htmlFor = `col-${index}`;
        label.textContent = header || `Column ${index + 1}`;
        
        div.appendChild(checkbox);
        div.appendChild(label);
        columnCheckboxes.appendChild(div);
        
        checkbox.addEventListener('change', updateSelectedColumns);
    });
    
    updateSelectedColumns();
}

// Update selected columns array
function updateSelectedColumns() {
    const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    selectedColumns = Array.from(checkboxes).map(cb => parseInt(cb.value));
    translateBtn.disabled = selectedColumns.length === 0;
}

// Initialize translator
async function initTranslator() {
    if (translator) return;
    
    modelStatus.style.display = 'block';
    
    try {
        translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
            progress_callback: (progress) => {
                if (progress.status === 'downloading') {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    modelProgress.style.width = percent + '%';
                    modelStatusText.textContent = `Downloading model: ${percent}%`;
                } else if (progress.status === 'loading') {
                    modelStatusText.textContent = 'Loading model...';
                } else if (progress.status === 'ready') {
                    modelStatusText.textContent = 'Model ready!';
                }
            }
        });
        
        modelStatusText.textContent = 'Model loaded successfully! ✓';
        setTimeout(() => {
            modelStatus.style.display = 'none';
        }, 2000);
        
    } catch (error) {
        console.error('Error loading model:', error);
        modelStatusText.textContent = 'Error loading model: ' + error.message;
        throw error;
    }
}

// Translate text
async function translateText(text, srcLang, tgtLang) {
    if (!text || text.trim() === '') return text;
    
    try {
        const result = await translator(text, {
            src_lang: srcLang,
            tgt_lang: tgtLang
        });
        return result[0].translation_text;
    } catch (error) {
        console.error('Translation error:', error);
        return text; // Return original text on error
    }
}

// Translate button handler
translateBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    
    translateBtn.disabled = true;
    downloadBtn.style.display = 'none';
    results.style.display = 'none';
    translationProgress.style.display = 'block';
    startTime = Date.now();
    
    try {
        await initTranslator();
        
        const srcLang = sourceLanguage.value;
        const tgtLang = targetLanguage.value;
        
        if (fileType === 'excel') {
            await translateExcel(srcLang, tgtLang);
        } else if (fileType === 'word') {
            await translateWord(srcLang, tgtLang);
        }
        
        // Show results
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        timeTaken.textContent = `${elapsed} seconds`;
        results.style.display = 'block';
        downloadBtn.style.display = 'block';
        
    } catch (error) {
        console.error('Translation error:', error);
        alert('Translation failed: ' + error.message);
    } finally {
        translateBtn.disabled = false;
        translationProgress.style.display = 'none';
    }
});

// Translate Excel file
async function translateExcel(srcLang, tgtLang) {
    const worksheet = workbook.Sheets[selectedSheet];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    
    const headers = jsonData[0];
    const dataRows = jsonData.slice(1);
    
    // Count total items to translate
    let totalItems = 0;
    for (const row of dataRows) {
        for (const colIdx of selectedColumns) {
            if (row[colIdx] && typeof row[colIdx] === 'string' && row[colIdx].trim() !== '') {
                totalItems++;
            }
        }
    }
    
    let translated = 0;
    
    // Create new column headers for translations
    const newHeaders = [...headers];
    selectedColumns.forEach(colIdx => {
        newHeaders.push(`${headers[colIdx]} (Translated)`);
    });
    
    // Translate data
    const newData = [newHeaders];
    
    for (const row of dataRows) {
        const newRow = [...row];
        
        for (const colIdx of selectedColumns) {
            const text = row[colIdx];
            
            if (text && typeof text === 'string' && text.trim() !== '') {
                currentItem.textContent = `Translating: ${text.substring(0, 50)}...`;
                const translatedText = await translateText(text, srcLang, tgtLang);
                newRow.push(translatedText);
                translated++;
            } else {
                newRow.push('');
            }
            
            // Update progress
            const percent = Math.round((translated / totalItems) * 100);
            translationProgressBar.style.width = percent + '%';
            progressText.textContent = `${translated} / ${totalItems}`;
            progressPercentage.textContent = `${percent}%`;
        }
        
        newData.push(newRow);
    }
    
    // Create new workbook with translated data
    const newWorksheet = XLSX.utils.aoa_to_sheet(newData);
    const newWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, selectedSheet);
    
    // Copy other sheets if they exist
    workbook.SheetNames.forEach(sheetName => {
        if (sheetName !== selectedSheet) {
            XLSX.utils.book_append_sheet(newWorkbook, workbook.Sheets[sheetName], sheetName);
        }
    });
    
    translatedData = newWorkbook;
    totalTranslated.textContent = translated;
}

// Translate Word document
async function translateWord(srcLang, tgtLang) {
    try {
        const arrayBuffer = await currentFile.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        const text = result.value;
        
        // Split into paragraphs
        const paragraphs = text.split('\n').filter(p => p.trim() !== '');
        const totalItems = paragraphs.length;
        let translated = 0;
        
        const translatedParagraphs = [];
        
        for (const paragraph of paragraphs) {
            currentItem.textContent = `Translating: ${paragraph.substring(0, 50)}...`;
            const translatedText = await translateText(paragraph, srcLang, tgtLang);
            translatedParagraphs.push(translatedText);
            translated++;
            
            // Update progress
            const percent = Math.round((translated / totalItems) * 100);
            translationProgressBar.style.width = percent + '%';
            progressText.textContent = `${translated} / ${totalItems}`;
            progressPercentage.textContent = `${percent}%`;
        }
        
        translatedData = translatedParagraphs.join('\n\n');
        totalTranslated.textContent = translated;
        
    } catch (error) {
        console.error('Error translating Word document:', error);
        throw error;
    }
}

// Download button handler
downloadBtn.addEventListener('click', () => {
    if (!translatedData) return;
    
    const originalName = currentFile.name.replace(/\.[^/.]+$/, '');
    
    if (fileType === 'excel') {
        XLSX.writeFile(translatedData, `${originalName}_translated.xlsx`);
    } else if (fileType === 'word') {
        const blob = new Blob([translatedData], { type: 'text/plain' });
        saveAs(blob, `${originalName}_translated.txt`);
    }
});

// Clear data button handler
document.getElementById('clearDataBtn')?.addEventListener('click', () => {
    if (confirm('Clear all data from memory and browser? This will remove uploaded files and translations.')) {
        // Clear application data
        currentFile = null;
        workbook = null;
        translatedData = null;
        translator = null;
        selectedColumns = [];
        selectedSheet = null;
        
        // Clear UI
        fileInfo.style.display = 'none';
        excelSettings.style.display = 'none';
        results.style.display = 'none';
        downloadBtn.style.display = 'none';
        translateBtn.disabled = true;
        
        // Reset file input
        fileInput.value = '';
        
        // Call security manager
        if (window.medmorfSecurity) {
            window.medmorfSecurity.clearAll();
        }
        
        alert('✅ All data cleared! Safe to close browser.');
    }
});

// Add warning when user is about to leave with data
window.addEventListener('beforeunload', (e) => {
    if (currentFile || translatedData) {
        e.preventDefault();
        e.returnValue = 'You have processed data in memory. Clear it before leaving for maximum security.';
    }
});

// Initialize
console.log('Translation app initialized');
console.log('🔒 PRIVACY: All processing happens in YOUR browser only');
console.log('🔒 PRIVACY: NO data is ever sent to any server');
console.log('🔒 PRIVACY: Type window.medmorfSecurity.showWarnings() for privacy info');
