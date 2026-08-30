// try-example.js
// One-click "Try example" buttons. Each button carries:
//   data-try-example  URL of the bundled sample file (same-origin)
//   data-try-target   selector of the <input type="file"> to feed
//   data-try-click    optional selector of the action button to press next
// The sample is fetched, wrapped in a File and dispatched through the normal
// change event, so every tab's existing upload pipeline runs unchanged — no
// download-then-reupload dance, and nothing leaves the browser.

const MIME = { txt: 'text/plain', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', wav: 'audio/wav', mp3: 'audio/mpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function runExample(btn) {
    const url = btn.dataset.tryExample;
    const input = document.querySelector(btn.dataset.tryTarget);
    if (!url || !input) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading example…';
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const name = url.split('/').pop();
        const ext = name.split('.').pop().toLowerCase();
        const file = new File([blob], name, { type: blob.type || MIME[ext] || 'application/octet-stream' });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (btn.dataset.tryClick) {
            // Give the tab's change handler a beat to enable its action button.
            setTimeout(() => {
                const action = document.querySelector(btn.dataset.tryClick);
                if (action && !action.disabled) action.click();
                else action?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 600);
        }
    } catch (err) {
        console.error('[try-example] failed:', err);
        alert('Could not load the example: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-try-example]');
    if (btn) { ev.preventDefault(); runExample(btn); }
});
