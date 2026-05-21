import { preloadTranslationModel, TRANSLATION_MODEL, TRANSLATION_RUNTIME_LABEL } from './translation-runtime.js?v=2026-03-23-cachefix-7';
import {
    DEFAULT_NER_MODEL_ID,
    getNERModelOption,
    preloadNERModel,
} from './privacy-runtime.js?v=2026-05-21-tfjs4';

// Cache & Storage Manager — inspect and manage browser-stored AI model data.
// Shows Cache API entries (translation/NER models) and IndexedDB databases (WebLLM).
// Pre-downloads models for offline use.
// User/patient data is NEVER stored here — only AI model weights.

const BUILD_ID = window.MEDMORF_BUILD_ID || 'unknown-build';
console.log('[BUILD] cache-manager.js build', BUILD_ID, 'module url', import.meta.url);

const LLM_MODEL = 'Qwen3-4B-q4f16_1-MLC';

function formatLoadError(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

const storageTotalSize = document.getElementById('storageTotalSize');
const storageCacheCount = document.getElementById('storageCacheCount');
const storageIDBCount = document.getElementById('storageIDBCount');
const storageCacheList = document.getElementById('storageCacheList');
const storageIDBList = document.getElementById('storageIDBList');
const storageRefreshBtn = document.getElementById('storageRefreshBtn');
const storageDeleteAllBtn = document.getElementById('storageDeleteAllBtn');

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Cache API Inspection ───────────────────────────────────────────────────────
async function scanCacheAPI() {
    const cacheNames = await caches.keys();
    let totalSize = 0;
    let totalEntries = 0;
    const cacheGroups = [];

    for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        let groupSize = 0;
        const entries = [];

        for (const request of keys) {
            try {
                const response = await cache.match(request);
                const blob = await response.clone().blob();
                const size = blob.size;
                groupSize += size;
                // Extract readable path from URL
                const url = new URL(request.url);
                const path = decodeURIComponent(url.pathname);
                entries.push({ url: request.url, path, size });
            } catch {
                entries.push({ url: request.url, path: request.url, size: 0 });
            }
        }

        totalSize += groupSize;
        totalEntries += entries.length;
        cacheGroups.push({ name, entries, size: groupSize });
    }

    return { cacheGroups, totalSize, totalEntries };
}

// ── IndexedDB Inspection ───────────────────────────────────────────────────────
async function scanIndexedDB() {
    const databases = [];
    let totalSize = 0;

    try {
        const dbList = await indexedDB.databases();
        for (const dbInfo of dbList) {
            const name = dbInfo.name || '(unnamed)';
            let size = 0;
            let storeNames = [];

            try {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(name);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });

                storeNames = Array.from(db.objectStoreNames);

                // Estimate size by reading all stores
                for (const storeName of storeNames) {
                    try {
                        const tx = db.transaction(storeName, 'readonly');
                        const store = tx.objectStore(storeName);
                        const countReq = store.count();
                        const count = await new Promise((resolve) => {
                            countReq.onsuccess = () => resolve(countReq.result);
                            countReq.onerror = () => resolve(0);
                        });
                        // Estimate size: sample a few records
                        if (count > 0) {
                            const cursorReq = store.openCursor();
                            let sampled = 0;
                            let sampleSize = 0;
                            await new Promise((resolve) => {
                                cursorReq.onsuccess = (e) => {
                                    const cursor = e.target.result;
                                    if (cursor && sampled < 3) {
                                        try {
                                            const val = cursor.value;
                                            if (val instanceof ArrayBuffer) {
                                                sampleSize += val.byteLength;
                                            } else if (val instanceof Blob) {
                                                sampleSize += val.size;
                                            } else {
                                                sampleSize += JSON.stringify(val).length;
                                            }
                                        } catch { /* skip */ }
                                        sampled++;
                                        cursor.continue();
                                    } else {
                                        resolve();
                                    }
                                };
                                cursorReq.onerror = () => resolve();
                            });
                            if (sampled > 0) {
                                size += Math.round((sampleSize / sampled) * count);
                            }
                        }
                    } catch { /* store access error, skip */ }
                }

                db.close();
            } catch { /* db open error */ }

            totalSize += size;
            databases.push({ name, version: dbInfo.version, storeNames, size });
        }
    } catch {
        // indexedDB.databases() not supported in some browsers
    }

    return { databases, totalSize };
}

// ── Storage Quota ──────────────────────────────────────────────────────────────
async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
    }
    return null;
}

// ── Render ─────────────────────────────────────────────────────────────────────
function renderCacheGroup(group) {
    const section = document.createElement('div');
    section.className = 'storage-cache-group';

    const header = document.createElement('div');
    header.className = 'storage-group-header';
    header.innerHTML = `
        <div class="storage-group-title">
            <strong>${escapeHTML(group.name)}</strong>
            <span class="storage-group-meta">${group.entries.length} file${group.entries.length !== 1 ? 's' : ''} · ${formatBytes(group.size)}</span>
        </div>
        <button class="btn btn-small btn-danger-outline storage-delete-cache" data-cache="${escapeHTML(group.name)}" title="Delete this cache">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete
        </button>
    `;
    section.appendChild(header);

    // Collapsible entries
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show cached files';
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'storage-entry-list';
    for (const entry of group.entries) {
        const row = document.createElement('div');
        row.className = 'storage-entry';
        row.innerHTML = `
            <span class="storage-entry-path" title="${escapeHTML(entry.url)}">${escapeHTML(entry.path)}</span>
            <span class="storage-entry-size">${formatBytes(entry.size)}</span>
        `;
        list.appendChild(row);
    }
    details.appendChild(list);
    section.appendChild(details);

    return section;
}

function renderIDBDatabase(db) {
    const section = document.createElement('div');
    section.className = 'storage-idb-group';

    section.innerHTML = `
        <div class="storage-group-header">
            <div class="storage-group-title">
                <strong>${escapeHTML(db.name)}</strong>
                <span class="storage-group-meta">v${db.version || '?'} · ${db.storeNames.length} store${db.storeNames.length !== 1 ? 's' : ''} · ~${formatBytes(db.size)}</span>
            </div>
            <button class="btn btn-small btn-danger-outline storage-delete-idb" data-db="${escapeHTML(db.name)}" title="Delete this database">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                Delete
            </button>
        </div>
        <div class="storage-idb-stores">
            <span class="storage-hint">Stores: ${db.storeNames.map(s => escapeHTML(s)).join(', ') || '(none)'}</span>
        </div>
    `;

    return section;
}

async function refreshStorageView() {
    storageCacheList.innerHTML = '<p class="storage-empty">Scanning cache...</p>';
    storageIDBList.innerHTML = '<p class="storage-empty">Scanning databases...</p>';
    storageTotalSize.textContent = 'Scanning...';
    storageCacheCount.textContent = '—';
    storageIDBCount.textContent = '—';

    // Run scans in parallel
    const [cacheResult, idbResult, estimate] = await Promise.all([
        scanCacheAPI().catch(() => ({ cacheGroups: [], totalSize: 0, totalEntries: 0 })),
        scanIndexedDB().catch(() => ({ databases: [], totalSize: 0 })),
        getStorageEstimate(),
    ]);

    // Summary
    const enumeratedSize = cacheResult.totalSize + idbResult.totalSize;
    const totalUsage = estimate ? estimate.usage : enumeratedSize;
    storageTotalSize.textContent = formatBytes(totalUsage);
    storageCacheCount.textContent = String(cacheResult.totalEntries);
    storageIDBCount.textContent = String(idbResult.databases.length);

    // Cache list
    storageCacheList.innerHTML = '';
    if (cacheResult.cacheGroups.length === 0) {
        storageCacheList.innerHTML = '<p class="storage-empty">No cached files found. Models will be downloaded on first use.</p>';
    } else {
        for (const group of cacheResult.cacheGroups) {
            storageCacheList.appendChild(renderCacheGroup(group));
        }
    }

    // IDB list
    storageIDBList.innerHTML = '';
    if (idbResult.databases.length === 0) {
        storageIDBList.innerHTML = '<p class="storage-empty">No IndexedDB databases found.</p>';
    } else {
        for (const db of idbResult.databases) {
            storageIDBList.appendChild(renderIDBDatabase(db));
        }
    }

    // Wire up delete buttons
    storageCacheList.querySelectorAll('.storage-delete-cache').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.cache;
            if (!confirm(`Delete cache "${name}"? You will need to re-download these model files.`)) return;
            try {
                await caches.delete(name);
                refreshStorageView();
            } catch (e) {
                alert('Error deleting cache: ' + e.message);
            }
        });
    });

    storageIDBList.querySelectorAll('.storage-delete-idb').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.db;
            if (!confirm(`Delete database "${name}"? You will need to re-download model data.`)) return;
            try {
                await new Promise((resolve, reject) => {
                    const req = indexedDB.deleteDatabase(name);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(new Error('Could not delete database'));
                    req.onblocked = () => reject(new Error('Database is in use. Close other tabs using this site and try again.'));
                });
                refreshStorageView();
            } catch (e) {
                alert('Error: ' + e.message);
            }
        });
    });
}

// ── Delete All ─────────────────────────────────────────────────────────────────
async function deleteAllStorage() {
    if (!confirm('Delete ALL cached models? You will need to re-download them.\n\nNo personal data is stored — only AI model weights.')) return;

    try {
        // Delete all Cache API caches
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));

        // Delete all IndexedDB databases
        if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            await Promise.all(dbs.map(db => new Promise(resolve => {
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            })));
        }
    } catch (e) {
        console.error('Error clearing storage:', e);
    }

    refreshStorageView();
    checkAllOfflineStatus();
    window.dispatchEvent(new CustomEvent('medmorf:translation-cache-updated'));
}

// ── Event Listeners ────────────────────────────────────────────────────────────
if (storageRefreshBtn) storageRefreshBtn.addEventListener('click', refreshStorageView);
if (storageDeleteAllBtn) storageDeleteAllBtn.addEventListener('click', deleteAllStorage);

// ── Offline Download UI Elements ───────────────────────────────────────────────
const offlineTranslationBtn = document.getElementById('offlineTranslationBtn');
const offlineTranslationText = document.getElementById('offlineTranslationText');
const offlineTranslationProgress = document.getElementById('offlineTranslationProgress');
const offlineTranslationBar = document.getElementById('offlineTranslationBar');
const offlineTranslationPct = document.getElementById('offlineTranslationPct');
const offlineTranslationCard = document.getElementById('offlineTranslation');

const offlineNERBtn = document.getElementById('offlineNERBtn');
const offlineNERText = document.getElementById('offlineNERText');
const offlineNERProgress = document.getElementById('offlineNERProgress');
const offlineNERBar = document.getElementById('offlineNERBar');
const offlineNERPct = document.getElementById('offlineNERPct');
const offlineNERCard = document.getElementById('offlineNER');
const offlineNERMeta = document.getElementById('offlineNERMeta');
const offlineNERDesc = document.getElementById('offlineNERDesc');

const offlineLLMBtn = document.getElementById('offlineLLMBtn');
const offlineLLMText = document.getElementById('offlineLLMText');
const offlineLLMProgress = document.getElementById('offlineLLMProgress');
const offlineLLMBar = document.getElementById('offlineLLMBar');
const offlineLLMPct = document.getElementById('offlineLLMPct');
const offlineLLMCard = document.getElementById('offlineLLM');

const offlineSTTBtn = document.getElementById('offlineSTTBtn');
const offlineSTTText = document.getElementById('offlineSTTText');
const offlineSTTProgress = document.getElementById('offlineSTTProgress');
const offlineSTTBar = document.getElementById('offlineSTTBar');
const offlineSTTPct = document.getElementById('offlineSTTPct');
const offlineSTTCard = document.getElementById('offlineSTT');
const offlineSTTMeta = document.getElementById('offlineSTTMeta');

const offlineDownloadAllBtn = document.getElementById('offlineDownloadAllBtn');

function getSelectedNerModelId() {
    const select = document.getElementById('anonNerModelSelect');
    return select ? select.value : DEFAULT_NER_MODEL_ID;
}

function getSelectedNerModelOption() {
    return getNERModelOption(getSelectedNerModelId());
}

function refreshNerCardDetails() {
    const option = getSelectedNerModelOption();
    if (offlineNERMeta) {
        const sizeLabels = {
            multilang_pii: 'Multilingual PII NER · ~280 MB',
            gliner_pii: 'GLiNER PII Edge · ~46 MB',
            multilingual_ner: 'Multilingual BERT · ~100 MB',
            openai_privacy_filter: 'OpenAI Privacy Filter · ~800 MB (q4)',
        };
        offlineNERMeta.textContent = sizeLabels[option.id] || option.label;
    }
    if (offlineNERDesc) {
        offlineNERDesc.textContent = option.description;
    }
}

// ── Offline Status Check ───────────────────────────────────────────────────────
function setCardStatus(card, textEl, btn, status) {
    // status: 'checking', 'cached', 'not-cached', 'downloading', 'done', 'error'
    card.dataset.status = status;
    if (status === 'cached' || status === 'done') {
        textEl.textContent = '✓ Cached — ready for offline';
        textEl.className = 'offline-status-text status-cached';
        btn.textContent = 'Downloaded';
        btn.disabled = true;
        btn.classList.add('btn-cached');
    } else if (status === 'not-cached') {
        textEl.textContent = 'Not downloaded';
        textEl.className = 'offline-status-text status-missing';
        btn.disabled = false;
        btn.classList.remove('btn-cached');
    } else if (status === 'downloading') {
        textEl.textContent = 'Downloading...';
        textEl.className = 'offline-status-text status-downloading';
        btn.disabled = true;
        btn.classList.remove('btn-cached');
    } else if (status === 'error') {
        textEl.className = 'offline-status-text status-missing';
        btn.disabled = false;
        btn.classList.remove('btn-cached');
    }
}

async function checkTranslationCached() {
    try {
        const names = await caches.keys();
        for (const name of names) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            if (keys.some(r => r.url.includes('nllb-200-distilled-600M'))) {
                setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'cached');
                return true;
            }
        }
        setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'not-cached');
        return false;
    } catch {
        setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'not-cached');
        return false;
    }
}

async function checkNERCached() {
    const option = getSelectedNerModelOption();
    try {
        const names = await caches.keys();
        for (const name of names) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            if (keys.some(r => option.cacheMatchers.some(matcher => r.url.includes(matcher)))) {
                setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'cached');
                return true;
            }
        }
        setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'not-cached');
        return false;
    } catch {
        setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'not-cached');
        return false;
    }
}

async function checkLLMCached() {
    try {
        // WebLLM v0.2.x stores model weights in the Cache API, not IndexedDB
        const cacheNames = await caches.keys();
        const hasLLMCache = cacheNames.some(name => {
            const lower = name.toLowerCase();
            return lower.includes('webllm') || lower.includes('mlc') || lower.includes('tvmjs')
                || (lower.includes('cache') && lower.includes('model'));
        });
        if (hasLLMCache) {
            // Verify at least one shard is present
            for (const name of cacheNames) {
                const lower = name.toLowerCase();
                if (lower.includes('webllm') || lower.includes('mlc') || lower.includes('tvmjs')) {
                    const cache = await caches.open(name);
                    const keys = await cache.keys();
                    if (keys.length > 0) {
                        setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'cached');
                        return true;
                    }
                }
            }
        }

        // Fallback: check IndexedDB as well (older WebLLM versions)
        if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            const hasLLMIDB = dbs.some(db => {
                const name = (db.name || '').toLowerCase();
                return name.includes('webllm') || name.includes('mlc') || name.includes('tvmjs')
                    || (name.includes('cache') && name.includes('model'));
            });
            if (hasLLMIDB) {
                setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'cached');
                return true;
            }
        }

        setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'not-cached');
        return false;
    } catch {
        setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'not-cached');
        return false;
    }
}

async function checkSTTCached() {
    if (!offlineSTTCard) return false;
    // Update meta label with selected model
    const stt = window.medmorfSTTData;
    if (stt && offlineSTTMeta) {
        const modelId = stt.getSelectedModel();
        const shortName = modelId.split('/').pop() || 'Whisper';
        offlineSTTMeta.textContent = `${shortName}`;
    }
    try {
        const names = await caches.keys();
        for (const name of names) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            if (keys.some(r => r.url.includes('whisper'))) {
                setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'cached');
                return true;
            }
        }
        setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'not-cached');
        return false;
    } catch {
        setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'not-cached');
        return false;
    }
}

async function checkAllOfflineStatus() {
    await Promise.all([checkTranslationCached(), checkNERCached(), checkLLMCached(), checkSTTCached()]);
    updateDownloadAllBtn();
}

async function requestPersistentStorage() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            const granted = await navigator.storage.persist();
            console.log('[STORAGE] Persistent storage', granted ? 'granted' : 'denied');
        }
    } catch { /* ignore */ }
}

function updateDownloadAllBtn() {
    const cards = [offlineTranslationCard, offlineNERCard, offlineLLMCard, offlineSTTCard].filter(Boolean);
    const allCached = cards.every(c => c.dataset.status === 'cached' || c.dataset.status === 'done');
    if (allCached) {
        offlineDownloadAllBtn.textContent = '✓ All models ready for offline use';
        offlineDownloadAllBtn.disabled = true;
        offlineDownloadAllBtn.classList.add('btn-cached');
    } else {
        offlineDownloadAllBtn.disabled = false;
        offlineDownloadAllBtn.classList.remove('btn-cached');
    }
}

// ── Download Functions ─────────────────────────────────────────────────────────
let downloadingTranslation = false;
let downloadingNER = false;
let downloadingLLM = false;

async function downloadTranslationModel() {
    if (downloadingTranslation) return;
    downloadingTranslation = true;
    setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'downloading');
    offlineTranslationProgress.style.display = 'block';
    offlineTranslationBar.style.width = '0%';
    offlineTranslationPct.textContent = '0%';

    try {
        console.log('[CACHE] preloading translation model', TRANSLATION_MODEL, 'with', TRANSLATION_RUNTIME_LABEL);
        const fileProgress = {};
        const loggedFiles = new Set();
        await preloadTranslationModel({
            progressCallback: (progress) => {
                if (progress.file && !loggedFiles.has(progress.file)) {
                    loggedFiles.add(progress.file);
                    console.log('[CACHE] loading file', progress.file);
                }
                if (progress.status === 'progress' && progress.total > 0) {
                    const fileName = progress.file || 'data';
                    fileProgress[fileName] = { loaded: progress.loaded, total: progress.total };
                    const totalLoaded = Object.values(fileProgress).reduce((a, c) => a + c.loaded, 0);
                    const totalSize = Object.values(fileProgress).reduce((a, c) => a + c.total, 0);
                    const pct = Math.round((totalLoaded / totalSize) * 100);
                    offlineTranslationBar.style.width = pct + '%';
                    offlineTranslationPct.textContent = pct + '%';
                }
            },
        });

        offlineTranslationProgress.style.display = 'none';
        setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'done');
        requestPersistentStorage();
        window.dispatchEvent(new CustomEvent('medmorf:translation-cache-updated'));
    } catch (err) {
        console.error('Translation model download error:', err);
        offlineTranslationText.textContent = 'Error: ' + formatLoadError(err);
        setCardStatus(offlineTranslationCard, offlineTranslationText, offlineTranslationBtn, 'error');
        offlineTranslationText.textContent = 'Download failed — ' + formatLoadError(err);
        offlineTranslationProgress.style.display = 'none';
    } finally {
        downloadingTranslation = false;
        updateDownloadAllBtn();
    }
}

async function downloadNERModel() {
    if (downloadingNER) return;
    downloadingNER = true;
    setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'downloading');
    offlineNERProgress.style.display = 'block';
    offlineNERBar.style.width = '0%';
    offlineNERPct.textContent = '0%';

    try {
        const option = getSelectedNerModelOption();
        console.log('[CACHE] preloading NER model', option.model);
        await preloadNERModel({
            modelId: option.id,
            progressCallback: (progress) => {
                if (progress.status === 'progress' && progress.total > 0) {
                    const pct = Math.round((progress.loaded / progress.total) * 100);
                    offlineNERBar.style.width = pct + '%';
                    offlineNERPct.textContent = pct + '%';
                }
            },
        });

        offlineNERProgress.style.display = 'none';
        setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'done');
        requestPersistentStorage();
    } catch (err) {
        console.error('NER model download error:', err);
        setCardStatus(offlineNERCard, offlineNERText, offlineNERBtn, 'error');
        offlineNERText.textContent = 'Download failed — ' + err.message;
        offlineNERProgress.style.display = 'none';
    } finally {
        downloadingNER = false;
        updateDownloadAllBtn();
    }
}

async function downloadLLMModel() {
    if (downloadingLLM) return;
    downloadingLLM = true;
    setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'downloading');
    offlineLLMProgress.style.display = 'block';
    offlineLLMBar.style.width = '0%';
    offlineLLMPct.textContent = '0%';

    try {
        const { CreateMLCEngine } = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.82/lib/index.js');
        const engine = await CreateMLCEngine(LLM_MODEL, {
            initProgressCallback: (progress) => {
                const text = progress.text || '';
                const pctMatch = text.match(/(\d+(?:\.\d+)?)%/);
                if (pctMatch) {
                    offlineLLMBar.style.width = pctMatch[1] + '%';
                    offlineLLMPct.textContent = Math.round(parseFloat(pctMatch[1])) + '%';
                }
                offlineLLMText.textContent = text || 'Downloading...';
                offlineLLMText.className = 'offline-status-text status-downloading';
            },
        });
        // Unload engine to free GPU/memory — model is now cached
        if (engine && typeof engine.unload === 'function') await engine.unload();

        // Request persistent storage so macOS/Safari won't evict the cached model
        requestPersistentStorage();

        offlineLLMProgress.style.display = 'none';
        setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'done');
    } catch (err) {
        console.error('LLM model download error:', err);
        setCardStatus(offlineLLMCard, offlineLLMText, offlineLLMBtn, 'error');
        offlineLLMText.textContent = 'Download failed — ' + err.message;
        offlineLLMProgress.style.display = 'none';
    } finally {
        downloadingLLM = false;
        updateDownloadAllBtn();
    }
}

async function downloadAllModels() {
    // Start all downloads that aren't already cached
    const tasks = [];
    if (offlineTranslationCard.dataset.status !== 'cached' && offlineTranslationCard.dataset.status !== 'done') {
        tasks.push(downloadTranslationModel());
    }
    if (offlineNERCard.dataset.status !== 'cached' && offlineNERCard.dataset.status !== 'done') {
        tasks.push(downloadNERModel());
    }
    if (offlineLLMCard.dataset.status !== 'cached' && offlineLLMCard.dataset.status !== 'done') {
        tasks.push(downloadLLMModel());
    }
    if (offlineSTTCard && offlineSTTCard.dataset.status !== 'cached' && offlineSTTCard.dataset.status !== 'done') {
        tasks.push(downloadSTTModel());
    }
    await Promise.all(tasks);
    refreshStorageView();
}

let downloadingSTT = false;
async function downloadSTTModel() {
    if (downloadingSTT) return;
    const stt = window.medmorfSTTData;
    if (!stt) { console.warn('[CACHE] STT module not loaded'); return; }
    downloadingSTT = true;
    setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'downloading');
    offlineSTTProgress.style.display = 'block';
    offlineSTTBar.style.width = '0%';
    offlineSTTPct.textContent = '0%';

    try {
        await stt.preloadModel((progress) => {
            if (progress.status === 'progress' && progress.total > 0) {
                const pct = Math.round((progress.loaded / progress.total) * 100);
                offlineSTTBar.style.width = pct + '%';
                offlineSTTPct.textContent = pct + '%';
            }
        });

        offlineSTTProgress.style.display = 'none';
        setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'done');
        requestPersistentStorage();
    } catch (err) {
        console.error('STT model download error:', err);
        setCardStatus(offlineSTTCard, offlineSTTText, offlineSTTBtn, 'error');
        offlineSTTText.textContent = 'Download failed — ' + err.message;
        offlineSTTProgress.style.display = 'none';
    } finally {
        downloadingSTT = false;
        updateDownloadAllBtn();
    }
}

// Wire up download buttons
if (offlineTranslationBtn) offlineTranslationBtn.addEventListener('click', async () => {
    await downloadTranslationModel();
    refreshStorageView();
    window.dispatchEvent(new CustomEvent('medmorf:translation-cache-updated'));
});
if (offlineNERBtn) offlineNERBtn.addEventListener('click', async () => {
    await downloadNERModel();
    refreshStorageView();
});
if (offlineLLMBtn) offlineLLMBtn.addEventListener('click', async () => {
    await downloadLLMModel();
    refreshStorageView();
});
if (offlineSTTBtn) offlineSTTBtn.addEventListener('click', async () => {
    await downloadSTTModel();
    refreshStorageView();
});
if (offlineDownloadAllBtn) offlineDownloadAllBtn.addEventListener('click', downloadAllModels);

// ── Personal Data Inspector ────────────────────────────────────────────────────
const personalDataList = document.getElementById('personalDataList');
const clearPersonalDataBtn = document.getElementById('clearPersonalDataBtn');

function refreshPersonalDataView() {
    if (!personalDataList) return;

    const items = [];
    const t = window.medmorfTranslationData;
    const a = window.medmorfAnonymizeData;

    if (t) {
        if (t.hasFile()) items.push({ label: 'Translation file', detail: t.fileName(), type: 'file' });
        if (t.hasQuickText()) items.push({ label: 'Quick translate input text', detail: 'Text in input box', type: 'text' });
        if (t.hasQuickOutput()) items.push({ label: 'Quick translate output text', detail: 'Translated text in output box', type: 'text' });
        if (t.hasTranslation()) items.push({ label: 'Translated file data', detail: 'In-memory translation result', type: 'data' });
    }

    if (a) {
        if (a.hasDocument()) items.push({ label: 'Anonymization document', detail: a.documentName(), type: 'file' });
        if (a.hasResult()) items.push({ label: 'Anonymized result', detail: 'In-memory anonymized output', type: 'data' });
        if (a.hasMapping()) items.push({ label: 'Entity mapping', detail: `${a.mappingCount()} entities detected`, type: 'data' });
    }

    const s = window.medmorfSummarizeData;
    if (s) {
        if (s.hasDocument()) items.push({ label: 'Summarization document', detail: s.documentName(), type: 'file' });
        if (s.hasResult()) items.push({ label: 'Summary result', detail: 'In-memory summary output', type: 'data' });
    }

    const stt = window.medmorfSTTData;
    if (stt) {
        if (stt.hasRecording()) items.push({ label: 'Audio recording', detail: 'In-memory audio data', type: 'file' });
        if (stt.hasResult()) items.push({ label: 'Transcription result', detail: 'In-memory transcription text', type: 'data' });
    }

    personalDataList.innerHTML = '';

    if (items.length === 0) {
        personalDataList.innerHTML = '<p class="storage-empty personal-data-clean">\u2713 No personal data in memory — all clean</p>';
        if (clearPersonalDataBtn) clearPersonalDataBtn.disabled = true;
        return;
    }

    if (clearPersonalDataBtn) clearPersonalDataBtn.disabled = false;

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'personal-data-item';
        const iconClass = item.type === 'file' ? 'pd-file' : item.type === 'text' ? 'pd-text' : 'pd-data';
        row.innerHTML = `
            <span class="pd-icon ${iconClass}">\u25cf</span>
            <span class="pd-label">${escapeHTML(item.label)}</span>
            <span class="pd-detail">${escapeHTML(item.detail || '')}</span>
        `;
        personalDataList.appendChild(row);
    }
}

async function clearAllPersonalData() {
    if (window.medmorfTranslationData) await window.medmorfTranslationData.clearAll();
    if (window.medmorfAnonymizeData) await window.medmorfAnonymizeData.clearAll();
    if (window.medmorfSummarizeData) await window.medmorfSummarizeData.clearAll();
    if (window.medmorfSTTData) await window.medmorfSTTData.clearAll();
    refreshPersonalDataView();
}

if (clearPersonalDataBtn) clearPersonalDataBtn.addEventListener('click', () => { clearAllPersonalData(); });

const anonNerModelSelect = document.getElementById('anonNerModelSelect');
if (anonNerModelSelect) {
    anonNerModelSelect.addEventListener('change', async () => {
        refreshNerCardDetails();
        await checkNERCached();
        updateDownloadAllBtn();
    });
}

// Auto-scan when the storage tab is shown
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'storage') {
            refreshNerCardDetails();
            refreshStorageView();
            checkAllOfflineStatus();
            refreshPersonalDataView();
        }
    });
});

refreshNerCardDetails();
// Check offline status immediately on load, not only on tab click
checkAllOfflineStatus();
console.log('[STORAGE] Cache manager loaded');
