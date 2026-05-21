// Word Handler Module
// Handles Word document reading and text extraction using Mammoth.js

/**
 * Read Word document and extract text
 * @param {File} file - The Word (.docx) file to read
 * @returns {Promise<Object>} Object containing text and metadata
 */
async function readWordDocument(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        
        return {
            text: result.value,
            messages: result.messages,
            success: true
        };
    } catch (error) {
        console.error('Error reading Word document:', error);
        throw new Error('Failed to read Word document: ' + error.message);
    }
}

/**
 * Extract HTML from Word document (preserves some formatting)
 * @param {File} file - The Word (.docx) file to read
 * @returns {Promise<Object>} Object containing HTML and metadata
 */
async function readWordDocumentAsHTML(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        return {
            html: result.value,
            messages: result.messages,
            success: true
        };
    } catch (error) {
        console.error('Error reading Word document as HTML:', error);
        throw new Error('Failed to read Word document: ' + error.message);
    }
}

/**
 * Split document text into paragraphs
 * @param {string} text - The document text
 * @returns {Array<string>} Array of paragraphs
 */
function splitIntoParagraphs(text) {
    return text
        .split(/\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

/**
 * Split document text into sentences
 * @param {string} text - The document text
 * @returns {Array<string>} Array of sentences
 */
function splitIntoSentences(text) {
    // Simple sentence splitter - can be improved with NLP library if needed
    const sentences = text
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    
    return sentences;
}

/**
 * Split long text into chunks for translation
 * @param {string} text - The text to split
 * @param {number} maxLength - Maximum length per chunk
 * @returns {Array<string>} Array of text chunks
 */
function splitIntoChunks(text, maxLength = 500) {
    if (text.length <= maxLength) {
        return [text];
    }
    
    const chunks = [];
    const sentences = splitIntoSentences(text);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if ((currentChunk + ' ' + sentence).length <= maxLength) {
            currentChunk += (currentChunk ? ' ' : '') + sentence + '.';
        } else {
            if (currentChunk) {
                chunks.push(currentChunk);
            }
            currentChunk = sentence + '.';
        }
    }
    
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    
    return chunks;
}

/**
 * Get document statistics
 * @param {string} text - The document text
 * @returns {Object} Statistics object
 */
function getDocumentStats(text) {
    const paragraphs = splitIntoParagraphs(text);
    const sentences = splitIntoSentences(text);
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const characters = text.length;
    
    return {
        paragraphs: paragraphs.length,
        sentences: sentences.length,
        words: words.length,
        characters: characters,
        charactersNoSpaces: text.replace(/\s/g, '').length
    };
}

/**
 * Create a preview of document content
 * @param {string} text - The document text
 * @param {number} maxLength - Maximum length of preview
 * @returns {string} Preview text
 */
function createPreview(text, maxLength = 200) {
    if (text.length <= maxLength) {
        return text;
    }
    
    return text.substring(0, maxLength) + '...';
}

/**
 * Export translated text to plain text file
 * @param {string} text - The translated text
 * @param {string} filename - Name for the output file
 */
function exportAsText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    saveAs(blob, filename);
}

/**
 * Export translated text as markdown
 * @param {Array<string>} paragraphs - Array of translated paragraphs
 * @param {string} filename - Name for the output file
 * @param {Object} metadata - Optional metadata to include
 */
function exportAsMarkdown(paragraphs, filename, metadata = {}) {
    let markdown = '';
    
    // Add metadata header if provided
    if (metadata.title) {
        markdown += `# ${metadata.title}\n\n`;
    }
    
    if (metadata.sourceLanguage || metadata.targetLanguage) {
        markdown += `**Translation**: ${metadata.sourceLanguage || 'Unknown'} → ${metadata.targetLanguage || 'Unknown'}\n\n`;
    }
    
    if (metadata.date) {
        markdown += `**Date**: ${metadata.date}\n\n`;
    }
    
    markdown += '---\n\n';
    
    // Add paragraphs
    markdown += paragraphs.join('\n\n');
    
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    saveAs(blob, filename);
}

/**
 * Export translated paragraphs with original text for comparison
 * @param {Array<Object>} translations - Array of {original, translated} objects
 * @param {string} filename - Name for the output file
 */
function exportWithComparison(translations, filename) {
    let content = 'Original → Translated\n';
    content += '='.repeat(80) + '\n\n';
    
    translations.forEach((item, index) => {
        content += `Paragraph ${index + 1}:\n`;
        content += `ORIGINAL: ${item.original}\n\n`;
        content += `TRANSLATED: ${item.translated}\n\n`;
        content += '-'.repeat(80) + '\n\n';
    });
    
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    saveAs(blob, filename);
}

/**
 * Validate Word document file
 * @param {File} file - The file to validate
 * @returns {Object} Validation result
 */
function validateWordFile(file) {
    const validExtensions = ['.docx'];
    const maxSize = 10 * 1024 * 1024; // 10MB
    
    const extension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    
    if (!validExtensions.includes(extension)) {
        return {
            valid: false,
            error: 'Invalid file type. Please upload a .docx file.'
        };
    }
    
    if (file.size > maxSize) {
        return {
            valid: false,
            error: 'File is too large. Maximum size is 10MB.'
        };
    }
    
    return { valid: true };
}

/**
 * Clean and normalize text
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function cleanText(text) {
    return text
        // Remove multiple spaces
        .replace(/\s+/g, ' ')
        // Remove multiple newlines
        .replace(/\n{3,}/g, '\n\n')
        // Trim
        .trim();
}

/**
 * Extract tables from Word document
 * @param {File} file - The Word (.docx) file
 * @returns {Promise<Array>} Array of tables
 */
async function extractTables(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        // Note: Mammoth.js has limited table support
        // For better table extraction, consider using docx library
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        // Parse HTML to extract tables (basic implementation)
        const parser = new DOMParser();
        const doc = parser.parseFromString(result.html, 'text/html');
        const tables = doc.querySelectorAll('table');
        
        return Array.from(tables).map((table, index) => ({
            index,
            html: table.outerHTML,
            text: table.textContent
        }));
    } catch (error) {
        console.error('Error extracting tables:', error);
        return [];
    }
}

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        readWordDocument,
        readWordDocumentAsHTML,
        splitIntoParagraphs,
        splitIntoSentences,
        splitIntoChunks,
        getDocumentStats,
        createPreview,
        exportAsText,
        exportAsMarkdown,
        exportWithComparison,
        validateWordFile,
        cleanText,
        extractTables
    };
}
