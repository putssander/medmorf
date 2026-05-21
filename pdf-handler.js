// pdf-handler.js — Merge multiple PDF files into one, fully in-browser.
// Uses pdf-lib (loaded as a global `PDFLib` from CDN).
// No data leaves the device.

(function () {
    'use strict';

    const dropArea   = document.getElementById('mergepdfDrop');
    const fileInput  = document.getElementById('mergepdfInput');
    const listEl     = document.getElementById('mergepdfList');
    const listSection   = document.getElementById('mergepdfListSection');
    const mergeSection  = document.getElementById('mergepdfMergeSection');
    const clearBtn   = document.getElementById('mergepdfClearBtn');
    const mergeBtn   = document.getElementById('mergepdfMergeBtn');
    const filenameEl = document.getElementById('mergepdfFilename');
    const statusEl   = document.getElementById('mergepdfStatus');

    if (!dropArea || !fileInput) {
        // Tab markup not present — nothing to do.
        return;
    }

    /** @type {{id:number, file: File}[]} */
    const files = [];
    let nextId = 1;

    function setStatus(message, type) {
        if (!statusEl) return;
        statusEl.textContent = message || '';
        statusEl.className = 'mergepdf-status' + (type ? ' is-' + type : '');
    }

    function humanSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function render() {
        listEl.innerHTML = '';
        files.forEach((entry, idx) => {
            const li = document.createElement('li');
            li.className = 'mergepdf-item';

            const order = document.createElement('span');
            order.className = 'mergepdf-item-order';
            order.textContent = String(idx + 1);

            const info = document.createElement('div');
            info.className = 'mergepdf-item-info';
            const name = document.createElement('span');
            name.className = 'mergepdf-item-name';
            name.textContent = entry.file.name;
            const meta = document.createElement('span');
            meta.className = 'mergepdf-item-meta';
            meta.textContent = humanSize(entry.file.size);
            info.appendChild(name);
            info.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'mergepdf-item-actions';

            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'mergepdf-icon-btn';
            upBtn.title = 'Move up';
            upBtn.setAttribute('aria-label', 'Move up');
            upBtn.disabled = idx === 0;
            upBtn.textContent = '▲';
            upBtn.addEventListener('click', () => move(idx, -1));

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'mergepdf-icon-btn';
            downBtn.title = 'Move down';
            downBtn.setAttribute('aria-label', 'Move down');
            downBtn.disabled = idx === files.length - 1;
            downBtn.textContent = '▼';
            downBtn.addEventListener('click', () => move(idx, 1));

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'mergepdf-icon-btn mergepdf-remove-btn';
            removeBtn.title = 'Remove from list';
            removeBtn.setAttribute('aria-label', 'Remove');
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', () => remove(idx));

            actions.appendChild(upBtn);
            actions.appendChild(downBtn);
            actions.appendChild(removeBtn);

            li.appendChild(order);
            li.appendChild(info);
            li.appendChild(actions);
            listEl.appendChild(li);
        });

        const hasAny = files.length > 0;
        listSection.style.display = hasAny ? '' : 'none';
        mergeSection.style.display = hasAny ? '' : 'none';
        mergeBtn.disabled = files.length < 1;

        if (files.length === 1) {
            setStatus('Add at least one more PDF to merge.', 'hint');
        } else if (files.length > 1) {
            setStatus('Ready to merge ' + files.length + ' PDFs.', 'hint');
        } else {
            setStatus('', '');
        }
    }

    function move(idx, delta) {
        const target = idx + delta;
        if (target < 0 || target >= files.length) return;
        const tmp = files[idx];
        files[idx] = files[target];
        files[target] = tmp;
        render();
    }

    function remove(idx) {
        files.splice(idx, 1);
        render();
    }

    function addFiles(fileList) {
        const added = [];
        for (const f of fileList) {
            const isPdf = f.type === 'application/pdf' ||
                          f.name.toLowerCase().endsWith('.pdf');
            if (!isPdf) continue;
            files.push({ id: nextId++, file: f });
            added.push(f.name);
        }
        render();
        if (added.length === 0) {
            setStatus('Only PDF files are supported. Please choose .pdf files.', 'error');
        }
    }

    // ── Drop area wiring ──────────────────────────────────────────────────
    dropArea.addEventListener('click', () => fileInput.click());
    dropArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    dropArea.tabIndex = 0;

    fileInput.addEventListener('change', (e) => {
        addFiles(e.target.files);
        // Allow re-selecting the same file later
        fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(evt => {
        dropArea.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropArea.classList.add('is-dragover');
        });
    });
    ['dragleave', 'drop'].forEach(evt => {
        dropArea.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropArea.classList.remove('is-dragover');
        });
    });
    dropArea.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files) {
            addFiles(e.dataTransfer.files);
        }
    });

    clearBtn.addEventListener('click', () => {
        files.length = 0;
        render();
    });

    // ── Merging ──────────────────────────────────────────────────────────
    function sanitiseFilename(name) {
        let n = (name || '').trim();
        if (!n) n = 'merged.pdf';
        // Strip path separators and characters that are invalid on common OSes
        n = n.replace(/[\\/:*?"<>|]/g, '_');
        if (!/\.pdf$/i.test(n)) n += '.pdf';
        return n;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke after a short delay so the browser can start the download.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    mergeBtn.addEventListener('click', async () => {
        if (files.length === 0) return;
        if (typeof PDFLib === 'undefined' || !PDFLib.PDFDocument) {
            setStatus('PDF library failed to load. Please check your internet connection and reload the page.', 'error');
            return;
        }

        mergeBtn.disabled = true;
        clearBtn.disabled = true;
        setStatus('Merging ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '...', 'progress');

        try {
            const merged = await PDFLib.PDFDocument.create();

            for (let i = 0; i < files.length; i++) {
                const entry = files[i];
                setStatus(
                    'Reading ' + (i + 1) + ' of ' + files.length + ': ' + entry.file.name,
                    'progress'
                );
                const bytes = await entry.file.arrayBuffer();
                let src;
                try {
                    src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
                } catch (err) {
                    throw new Error('Could not read "' + entry.file.name + '". It may be password-protected or not a valid PDF.');
                }
                const pages = await merged.copyPages(src, src.getPageIndices());
                pages.forEach(p => merged.addPage(p));
            }

            setStatus('Saving merged PDF...', 'progress');
            const outBytes = await merged.save();
            const blob = new Blob([outBytes], { type: 'application/pdf' });
            const outName = sanitiseFilename(filenameEl.value);
            downloadBlob(blob, outName);

            setStatus('Done — saved as "' + outName + '".', 'success');
        } catch (err) {
            console.error('[MERGE-PDF] failed:', err);
            setStatus(err && err.message ? err.message : 'Merging failed. Please try again.', 'error');
        } finally {
            mergeBtn.disabled = files.length < 1;
            clearBtn.disabled = false;
        }
    });

    console.log('[MERGE-PDF] handler ready');
})();
