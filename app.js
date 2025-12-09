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
const modelCacheStatus = document.getElementById('modelCacheStatus');
const clearModelBtn = document.getElementById('clearModelBtn');
const systemStatusIndicator = document.querySelector('.status-indicator');
const systemStatusText = document.getElementById('systemStatusText');

function updateSystemStatus(state, message) {
    // state: 'idle', 'loading', 'translating'
    if (systemStatusIndicator) {
        systemStatusIndicator.className = `status-indicator ${state}`;
    }
    if (systemStatusText) {
        systemStatusText.textContent = message;
    }
}

// Quick translate DOM elements\nconst quickInputText = document.getElementById('quickInputText');\nconst quickOutputText = document.getElementById('quickOutputText');\nconst quickSourceLang = document.getElementById('quickSourceLang');\nconst quickTargetLang = document.getElementById('quickTargetLang');\nconst quickTranslateStatus = document.getElementById('quickTranslateStatus');\nconst inputCharCount = document.getElementById('inputCharCount');\nconst copyOutputBtn = document.getElementById('copyOutputBtn');


// Quick translate functionality
let quickTranslateTimeout = null;
let isQuickTranslateActive = false;
let lastTranslatedText = '';

quickInputText.addEventListener('input', () => {
    // Update character count
    inputCharCount.textContent = quickInputText.value.length;
    
    // Clear output if input is empty
    if (!quickInputText.value.trim()) {
        quickOutputText.value = '';
        quickTranslateStatus.innerHTML = '';
        quickTranslateStatus.className = 'quick-status';
        lastTranslatedText = '';
        return;
    }
    
    // Auto-translate with longer debounce (1.5s after user stops typing)
    clearTimeout(quickTranslateTimeout);
    quickTranslateTimeout = setTimeout(() => {
        // Only translate if text changed since last translation
        const currentText = quickInputText.value.trim();
        if (currentText && currentText !== lastTranslatedText) {
            performQuickTranslate();
        }
    }, 1500);
});

async function performQuickTranslate() {
    const text = quickInputText.value.trim();
    if (!text) return;
    
    // Prevent multiple simultaneous translations
    if (isQuickTranslateActive) return;
    
    const srcLang = quickSourceLang.value;
    const tgtLang = quickTargetLang.value;
    
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
        lastTranslatedText = text;
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

// Update selected columns array
function updateSelectedColumns() {
    const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    selectedColumns = Array.from(checkboxes).map(cb => parseInt(cb.value));
    translateBtn.disabled = selectedColumns.length === 0;
}

// Initialize translator
async function initTranslator() {
    if (translator) return;
    
    updateSystemStatus('loading', 'Loading model to memory...');
    
    // Show in appropriate location based on context
    if (!isQuickTranslateActive) {
        modelStatus.style.display = 'block';
    }
    
    // Track progress of all files to show a unified progress bar
    const fileProgress = {};
    
    try {
        translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
            progress_callback: (progress) => {
                if (progress.status === 'initiate') {
                    modelStatusText.textContent = 'Starting download...';
                    updateSystemStatus('loading', 'Starting model download...');
                } else if (progress.status === 'progress') {
                    // Update progress for this specific file
                    const fileName = progress.file || 'model data';
                    fileProgress[fileName] = {
                        loaded: progress.loaded,
                        total: progress.total
                    };
                    
                    // Calculate total progress across all files
                    const totalLoaded = Object.values(fileProgress).reduce((acc, curr) => acc + curr.loaded, 0);
                    const totalSize = Object.values(fileProgress).reduce((acc, curr) => acc + curr.total, 0);
                    
                    if (totalSize > 0) {
                        const totalPercent = Math.round((totalLoaded / totalSize) * 100);
                        
                        modelProgress.style.width = totalPercent + '%';
                        
                        if (isQuickTranslateActive) {
                            const quickProgressFill = document.getElementById('quickProgressFill');
                            if (quickProgressFill) {
                                quickProgressFill.style.width = totalPercent + '%';
                            }
                        }
                        
                        modelStatusText.textContent = `Downloading model: ${totalPercent}%`;
                        updateSystemStatus('loading', `Downloading model: ${totalPercent}%`);
                        
                        // Also update quick translate status text if active
                        if (isQuickTranslateActive) {
                            const statusContent = quickTranslateStatus.querySelector('.quick-status-content span:last-child');
                            if (statusContent) {
                                statusContent.textContent = `Downloading model: ${totalPercent}%`;
                            }
                        }
                    }
                } else if (progress.status === 'done') {
                    modelStatusText.textContent = 'Download complete. Loading to memory...';
                    updateSystemStatus('loading', 'Loading model to memory...');
                }
            }
        });
        
        modelStatusText.textContent = 'Model loaded successfully! ✓';
        updateSystemStatus('idle', 'System Ready (Idle)');
        checkModelStatus();
        setTimeout(() => {
            modelStatus.style.display = 'none';
        }, 2000);
        
    } catch (error) {
        console.error('Error loading model:', error);
        modelStatusText.textContent = 'Error loading model: ' + error.message;
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
        
        try {
            // Process paragraph
            const result = await translator(paragraph, {
                src_lang: srcLang,
                tgt_lang: tgtLang
            });
            translatedParagraphs.push(result[0].translation_text);
        } catch (error) {
            console.error('Translation error:', error);
            translatedParagraphs.push(paragraph); // Return original on error
        }
    }
    
    return translatedParagraphs.join('\n');
}

// Translate button handler
translateBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    
    translateBtn.disabled = true;
    downloadBtn.style.display = 'none';
    results.style.display = 'none';
    translationProgress.style.display = 'block';
    startTime = Date.now();
    updateSystemStatus('loading', 'Initializing translation...');
    
    try {
        await initTranslator();
        updateSystemStatus('translating', 'Translating file...');
        
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
        updateSystemStatus('idle', 'Translation failed');
    } finally {
        translateBtn.disabled = false;
        translationProgress.style.display = 'none';
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

// Automatic data clearing on page unload
function clearAllData() {
    console.log('[PRIVACY] Automatically clearing all data...');
    
    // Clear all data variables
    currentFile = null;
    workbook = null;
    selectedSheet = null;
    selectedColumns = [];
    translatedData = null;
    
    // Reset file input
    if (fileInput) {
        fileInput.value = '';
    }
    
    // Call security manager
    if (window.medmorfSecurity) {
        window.medmorfSecurity.clearAll();
    }
    
    console.log('[PRIVACY] All data cleared automatically');
}

// Clear data when page is unloaded (closing tab, refreshing, navigating away)
window.addEventListener('beforeunload', (e) => {
    clearAllData();
});

// Clear data when page becomes hidden (switching tabs, minimizing)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('[PRIVACY] Page hidden - keeping data in memory');
    }
});

// Clear data when page loses focus for extended period
let blurTimeout;
window.addEventListener('blur', () => {
    // Clear after 30 minutes of inactivity
    blurTimeout = setTimeout(() => {
        console.log('[PRIVACY] Extended inactivity - clearing data');
        clearAllData();
    }, 30 * 60 * 1000);
});

window.addEventListener('focus', () => {
    // Cancel the clear timeout if user returns
    if (blurTimeout) {
        clearTimeout(blurTimeout);
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

// Model Management
async function checkModelStatus() {
    if (!modelCacheStatus) return;
    
    try {
        const cacheExists = await caches.has('transformers-cache');
        if (cacheExists) {
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
        modelCacheStatus.textContent = 'Could not check model status';
    }
}

if (clearModelBtn) {
    clearModelBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete the cached model? You will need to download it again (~300MB) next time you translate.')) {
            return;
        }
        
        try {
            const deleted = await caches.delete('transformers-cache');
            if (deleted) {
                alert('Model cache cleared successfully.');
                checkModelStatus();
                // Reset translator instance
                translator = null;
            } else {
                alert('No model cache found to delete.');
            }
        } catch (error) {
            console.error('Error clearing cache:', error);
            alert('Error clearing cache: ' + error.message);
        }
    });
}

// Check status on load
checkModelStatus();
console.log('🔒 PRIVACY: Type window.medmorfSecurity.showWarnings() for privacy info');
