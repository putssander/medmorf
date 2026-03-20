// Data Privacy Module for Medmorf
// Ensures user/patient data never persists beyond the browser session.
// AI model caches (Cache API, IndexedDB) are intentionally preserved —
// they contain only model weights, never user data.

/**
 * Clear in-memory user data exposed on window globals.
 * Called automatically on page unload.
 */
function clearInMemoryData() {
    if (window.currentFile) window.currentFile = null;
    if (window.workbook) window.workbook = null;
    if (window.translatedData) window.translatedData = null;
    if (window.selectedColumns) window.selectedColumns = [];

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
}

/**
 * Initialize privacy safeguards.
 */
function initializeSecurity() {
    // Clear user data on page close / refresh
    window.addEventListener('beforeunload', clearInMemoryData);

    // Expose a manual "clear all user data" action
    window.medmorfSecurity = {
        clearAll: () => {
            clearInMemoryData();
            if (window.medmorfTranslationData) window.medmorfTranslationData.clearAll();
            if (window.medmorfAnonymizeData) window.medmorfAnonymizeData.clearAll();
        }
    };
}

if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', initializeSecurity);
}
