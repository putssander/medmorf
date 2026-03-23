import { pipeline, env } from '@huggingface/transformers';

// Configure transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

const TRANSLATION_MODEL = 'Xenova/nllb-200-distilled-600M';

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
const modelCacheStatus = document.getElementById('modelCacheStatus');
const clearModelBtn = document.getElementById('clearModelBtn');
const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');
const fileSourceLanguage = document.getElementById('fileSourceLanguage');
const fileTargetLanguage = document.getElementById('fileTargetLanguage');
const fileTranslateStatus = document.getElementById('fileTranslateStatus');
const fileStatusText = document.getElementById('fileStatusText');
const cancelTranslationBtn = document.getElementById('cancelTranslationBtn');
const deselectAllColumnsBtn = document.getElementById('deselectAllColumnsBtn');

let fileTranslationCancelled = false;

function updateSystemStatus(state, message) {
    // state: 'idle', 'loading', 'translating'
    if (systemStatusIndicator) {
        systemStatusIndicator.className = `status-indicator ${state}`;
    }
    if (systemStatusText) {
        systemStatusText.textContent = message;
    }
}

// Quick translate DOM elements
const quickInputText = document.getElementById('quickInputText');
const quickOutputText = document.getElementById('quickOutputText');
const quickTranslateStatus = document.getElementById('quickTranslateStatus');
const inputCharCount = document.getElementById('inputCharCount');
const copyOutputBtn = document.getElementById('copyOutputBtn');
const quickTranslateBtn = document.getElementById('quickTranslateBtn');


// Quick translate functionality
let isQuickTranslateActive = false;

quickInputText.addEventListener('input', () => {
    // Update character count
    inputCharCount.textContent = quickInputText.value.length;
    
    // Clear output if input is empty
    if (!quickInputText.value.trim()) {
        quickOutputText.value = '';
        quickTranslateStatus.innerHTML = '';
        quickTranslateStatus.className = 'quick-status';
        return;
    }
});

// Manual translate button
quickTranslateBtn.addEventListener('click', () => {
    const text = quickInputText.value.trim();
    if (text && !isQuickTranslateActive) {
        performQuickTranslate();
    }
});

// Also translate on Enter (Ctrl+Enter or Cmd+Enter)
quickInputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const text = quickInputText.value.trim();
        if (text && !isQuickTranslateActive) {
            performQuickTranslate();
        }
    }
});

async function performQuickTranslate() {
    const text = quickInputText.value.trim();
    if (!text) return;
    
    // Prevent multiple simultaneous translations
    if (isQuickTranslateActive) return;
    
    const srcLang = sourceLanguage.value;
    const tgtLang = targetLanguage.value;
    
    isQuickTranslateActive = true;
    updateSystemStatus('translating', 'Translating text...');
    
    // Show loading in quick translate area with progress bar
    if (!translator) {
        quickTranslateStatus.innerHTML = `
            <div class="quick-status-content">
                <span class="loading-spinner"></span>
                <span>Loading translation model (first time only)...</span>
            </div>
            <div class="quick-progress-bar">
                <div class="quick-progress-fill" id="quickProgressFill"></div>
            </div>
        `;
        quickTranslateStatus.className = 'quick-status loading';
    } else {
        quickTranslateStatus.innerHTML = `
            <div class="quick-status-content">
                <span class="loading-spinner"></span>
                <span>Translating...</span>
            </div>
        `;
        quickTranslateStatus.className = 'quick-status loading';
    }
    
    try {
        await initTranslator();
        updateSystemStatus('translating', 'Translating text...');
        quickTranslateStatus.innerHTML = `
            <div class="quick-status-content">
                <span class="loading-spinner"></span>
                <span>Translating...</span>
            </div>
        `;
        const result = await translateText(text, srcLang, tgtLang);
        quickOutputText.value = result;
        quickTranslateStatus.innerHTML = '';
        quickTranslateStatus.className = 'quick-status';
    } catch (error) {
        console.error('Quick translate error:', error);
        quickTranslateStatus.innerHTML = '<div class="quick-status-content">Translation failed. Please try again.</div>';
        quickTranslateStatus.className = 'quick-status error';
    } finally {
        isQuickTranslateActive = false;
        updateSystemStatus('idle', 'System Ready (Idle)');
    }
}

copyOutputBtn.addEventListener('click', async () => {
    const text = quickOutputText.value;
    if (!text) return;
    
    try {
        await navigator.clipboard.writeText(text);
        copyOutputBtn.classList.add('copied');
        copyOutputBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copied!
        `;
        setTimeout(() => {
            copyOutputBtn.classList.remove('copied');
            copyOutputBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy
            `;
        }, 2000);
    } catch (error) {
        console.error('Copy failed:', error);
    }
});

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

// Deselect all columns
deselectAllColumnsBtn.addEventListener('click', () => {
    columnCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });
    updateSelectedColumns();
});

// Cancel file translation
cancelTranslationBtn.addEventListener('click', () => {
    fileTranslationCancelled = true;
});

// Update selected columns array
function updateSelectedColumns() {
    const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    selectedColumns = Array.from(checkboxes).map(cb => parseInt(cb.value));
    translateBtn.disabled = selectedColumns.length === 0;
}

// Initialize translator — single pipeline instance for the page lifetime.
// Re-entrancy guard: if called while already loading, callers share the same promise.
let _initPromise = null;
async function initTranslator() {
    if (translator) return;
    if (_initPromise) return _initPromise;
    _initPromise = _loadPipeline();
    try { await _initPromise; } finally { _initPromise = null; }
}

async function _loadPipeline() {
    updateSystemStatus('loading', 'Loading translation model...');
    if (!isQuickTranslateActive) modelStatus.style.display = 'block';

    const fileProgress = {};
    try {
        // Set ONNX WASM paths before first pipeline call
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
        }
        translator = await pipeline('translation', TRANSLATION_MODEL, {
            quantized: true,
            progress_callback: (progress) => {
                if (progress.status === 'initiate') {
                    modelStatusText.textContent = 'Loading model...';
                } else if (progress.status === 'progress' && progress.total > 0) {
                    const file = progress.file || 'data';
                    fileProgress[file] = { loaded: progress.loaded, total: progress.total };
                    const loaded = Object.values(fileProgress).reduce((a, c) => a + c.loaded, 0);
                    const total = Object.values(fileProgress).reduce((a, c) => a + c.total, 0);
                    const pct = Math.round((loaded / total) * 100);
                    modelProgress.style.width = pct + '%';
                    modelStatusText.textContent = `Loading model: ${pct}%`;
                    updateSystemStatus('loading', `Loading model: ${pct}%`);
                    if (isQuickTranslateActive) {
                        const fill = document.getElementById('quickProgressFill');
                        if (fill) fill.style.width = pct + '%';
                        const span = quickTranslateStatus.querySelector('.quick-status-content span:last-child');
                        if (span) span.textContent = `Loading model: ${pct}%`;
                    }
                    if (fileTranslateStatus.style.display !== 'none' && fileStatusText) {
                        fileStatusText.textContent = `Loading model: ${pct}%`;
                    }
                } else if (progress.status === 'done') {
                    modelStatusText.textContent = 'Initializing...';
                }
            }
        });
        modelStatusText.textContent = 'Model loaded ✓';
        updateSystemStatus('idle', 'System Ready (Idle)');
        checkModelStatus();
        setTimeout(() => { modelStatus.style.display = 'none'; }, 2000);
    } catch (error) {
        console.error('Error loading model:', error);
        modelStatusText.textContent = 'Error: ' + error.message;
        updateSystemStatus('idle', 'Error loading model');
        if (isQuickTranslateActive) {
            quickTranslateStatus.innerHTML = '<div class="quick-status-content">Error loading model: ' + error.message + '</div>';
            quickTranslateStatus.className = 'quick-status error';
        }
        throw error;
    }
}

// Translate text
async function translateText(text, srcLang, tgtLang) {
    if (!text || text.trim() === '') return text;
    if (srcLang === tgtLang) return text;
    
    // Split text into paragraphs to handle long inputs and avoid truncation
    // The model has a limited context window, so passing a huge block of text
    // often results in only the first part being translated.
    const paragraphs = text.split('\n');
    const translatedParagraphs = [];
    
    for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        
        if (!paragraph.trim()) {
            translatedParagraphs.push(paragraph);
            continue;
        }

        translatedParagraphs.push(await translateParagraph(paragraph, srcLang, tgtLang));
    }
    
    return translatedParagraphs.join('\n');
}

async function translateParagraph(paragraph, srcLang, tgtLang) {
    const result = await translator(paragraph, {
        src_lang: srcLang,
        tgt_lang: tgtLang
    });
    const translated = extractTranslationText(result);
    if (!translated) {
        throw new Error('Translation model returned an empty response');
    }
    return translated;
}

function extractTranslationText(result) {
    if (typeof result === 'string') {
        return result.trim();
    }

    if (Array.isArray(result) && result.length > 0) {
        const first = result[0];
        if (typeof first === 'string') {
            return first.trim();
        }
        if (first && typeof first.translation_text === 'string') {
            return first.translation_text.trim();
        }
        if (first && typeof first.generated_text === 'string') {
            return first.generated_text.trim();
        }
    }

    if (result && typeof result.translation_text === 'string') {
        return result.translation_text.trim();
    }

    if (result && typeof result.generated_text === 'string') {
        return result.generated_text.trim();
    }

    return '';
}

// Translate button handler
translateBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    
    fileTranslationCancelled = false;
    translateBtn.disabled = true;
    downloadBtn.style.display = 'none';
    results.style.display = 'none';
    fileTranslateStatus.style.display = 'block';
    fileStatusText.textContent = 'Loading model...';
    startTime = Date.now();
    updateSystemStatus('loading', 'Initializing translation...');
    
    try {
        await initTranslator();
        if (fileTranslationCancelled) throw new Error('Cancelled');
        updateSystemStatus('translating', 'Translating file...');
        fileStatusText.textContent = 'Translating...';
        
        const srcLang = fileSourceLanguage.value;
        const tgtLang = fileTargetLanguage.value;
        
        if (fileType === 'excel') {
            await translateExcel(srcLang, tgtLang);
        } else if (fileType === 'word') {
            await translateWord(srcLang, tgtLang);
        }
        
        if (fileTranslationCancelled) throw new Error('Cancelled');
        
        // Show results
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        timeTaken.textContent = `${elapsed} seconds`;
        results.style.display = 'block';
        downloadBtn.style.display = 'block';
        fileStatusText.textContent = 'Done!';
        
    } catch (error) {
        if (error.message === 'Cancelled') {
            fileStatusText.textContent = 'Cancelled';
            updateSystemStatus('idle', 'Translation cancelled');
        } else {
            console.error('Translation error:', error);
            alert('Translation failed: ' + error.message);
            updateSystemStatus('idle', 'Translation failed');
        }
    } finally {
        translateBtn.disabled = false;
        setTimeout(() => { fileTranslateStatus.style.display = 'none'; }, 2000);
        updateSystemStatus('idle', 'System Ready (Idle)');
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
        if (fileTranslationCancelled) throw new Error('Cancelled');
        const newRow = [...row];
        
        for (const colIdx of selectedColumns) {
            if (fileTranslationCancelled) throw new Error('Cancelled');
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
            fileStatusText.textContent = `Translating... ${percent}%`;
            
            // Yield to UI to prevent freezing
            await new Promise(r => setTimeout(r, 0));
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
            if (fileTranslationCancelled) throw new Error('Cancelled');
            currentItem.textContent = `Translating: ${paragraph.substring(0, 50)}...`;
            const translatedText = await translateText(paragraph, srcLang, tgtLang);
            translatedParagraphs.push(translatedText);
            translated++;
            
            // Update progress
            const percent = Math.round((translated / totalItems) * 100);
            translationProgressBar.style.width = percent + '%';
            progressText.textContent = `${translated} / ${totalItems}`;
            progressPercentage.textContent = `${percent}%`;
            fileStatusText.textContent = `Translating... ${percent}%`;
            
            // Yield to UI
            await new Promise(r => setTimeout(r, 0));
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

// Privacy: clear user/patient data from memory on page unload.
// Model caches (Cache API / IndexedDB) are never touched — they hold only
// AI model weights, never user data.
function clearUserData() {
    currentFile = null;
    workbook = null;
    selectedSheet = null;
    selectedColumns = [];
    translatedData = null;
    if (fileInput) fileInput.value = '';
    if (quickInputText) quickInputText.value = '';
    if (quickOutputText) quickOutputText.value = '';
}

window.addEventListener('beforeunload', () => { clearUserData(); });

// Expose in-memory data status for the Storage tab
window.medmorfTranslationData = {
    hasFile: () => currentFile !== null,
    fileName: () => currentFile ? currentFile.name : null,
    hasTranslation: () => translatedData !== null,
    hasQuickText: () => !!(quickInputText && quickInputText.value.trim()),
    hasQuickOutput: () => !!(quickOutputText && quickOutputText.value.trim()),
    clearAll: () => {
        currentFile = null;
        workbook = null;
        selectedSheet = null;
        selectedColumns = [];
        translatedData = null;
        fileType = null;
        if (fileInput) fileInput.value = '';
        if (quickInputText) quickInputText.value = '';
        if (quickOutputText) quickOutputText.value = '';
        if (fileInfo) fileInfo.style.display = 'none';
        if (results) results.style.display = 'none';
        if (downloadBtn) downloadBtn.style.display = 'none';
        if (inputCharCount) inputCharCount.textContent = '0';
        console.log('[PRIVACY] All translation data cleared');
    }
};

// Initialize
console.log('Translation app initialized');
console.log('🔒 PRIVACY: All processing happens in YOUR browser only');
console.log('🔒 PRIVACY: NO data is ever sent to any server');

// Model Management — check if the translation model is in the Cache API
async function checkModelStatus() {
    if (!modelCacheStatus) return;
    try {
        let cached = false;
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            if (keys.some(r => r.url.includes('nllb-200-distilled-600M'))) {
                cached = true;
                break;
            }
        }
        if (cached) {
            modelCacheStatus.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                Model is cached and ready for offline use
            `;
            clearModelBtn.disabled = false;
        } else {
            modelCacheStatus.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                Model not cached (will download on first use)
            `;
            clearModelBtn.disabled = true;
        }
    } catch (error) {
        console.error('Error checking cache:', error);
    }
}

window.addEventListener('medmorf:translation-cache-updated', () => { checkModelStatus(); });

if (clearModelBtn) {
    clearModelBtn.addEventListener('click', async () => {
        if (!confirm('Delete the cached translation model? You will need to re-download it (~300MB).')) return;
        try {
            const cacheNames = await caches.keys();
            for (const name of cacheNames) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                const modelKeys = keys.filter(r => r.url.includes('nllb-200-distilled-600M'));
                for (const key of modelKeys) {
                    await cache.delete(key);
                }
            }
            translator = null;
            _initPromise = null;
            checkModelStatus();
        } catch (error) {
            alert('Error clearing cache: ' + error.message);
        }
    });
}

checkModelStatus();
