// stt-store.js
// Crash-safe persistence for speech recordings. On a phone the browser can be
// killed at any moment (memory pressure during transcription is the common
// case — reported on iPhone 17 Pro). To guarantee audio is never lost:
//   - while recording, PCM chunks are appended to IndexedDB every few seconds;
//   - during transcription, the finished part of the transcript is saved per
//     segment;
//   - on the next page load the app offers Download / Resume / Discard.
// Privacy: everything stays in the browser's own storage on the device. The
// recovery entry is deleted automatically after a successful transcription,
// by "Discard", and by the Storage tab's "Delete all".

const DB_NAME = 'medmorf-stt-recovery';
const DB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('chunks')) {
                db.createObjectStore('chunks', { keyPath: ['session', 'seq'] });
            }
            if (!db.objectStoreNames.contains('sessions')) {
                db.createObjectStore('sessions', { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('idb transaction aborted'));
    });
}

let _db = null;
async function db() { return (_db ??= await openDB()); }

/** Start (or update) a recording session record. */
export async function startSession(id, meta = {}) {
    const d = await db();
    await tx(d, 'sessions', 'readwrite', s => s.put({
        id, startedAt: Date.now(), sampleRate: 16000, samples: 0,
        state: 'recording', transcript: '', doneSamples: 0, ...meta,
    }));
}

export async function updateSession(id, patch) {
    const d = await db();
    const cur = await tx(d, 'sessions', 'readonly', s => s.get(id));
    if (!cur) return;
    await tx(d, 'sessions', 'readwrite', s => s.put({ ...cur, ...patch, updatedAt: Date.now() }));
}

/** Append a PCM chunk (Float32Array @16 kHz). Stored as ArrayBuffer. */
export async function appendChunk(id, seq, float32) {
    const d = await db();
    // Copy: the caller may reuse/free its buffer.
    const buf = float32.slice().buffer;
    await tx(d, 'chunks', 'readwrite', s => s.put({ session: id, seq, buf }));
    const cur = await tx(d, 'sessions', 'readonly', s => s.get(id));
    if (cur) await tx(d, 'sessions', 'readwrite', s => s.put({ ...cur, samples: (cur.samples || 0) + float32.length, updatedAt: Date.now() }));
}

/** The most recent session that never completed, or null. */
export async function findRecoverable() {
    const d = await db();
    const all = await tx(d, 'sessions', 'readonly', s => s.getAll());
    const open = (all || []).filter(s => s.state !== 'done' && (s.samples || 0) > 16000); // ≥1 s of audio
    open.sort((a, b) => (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt));
    return open[0] || null;
}

/** Reassemble the full PCM for a session as one Float32Array. */
export async function loadPCM(id) {
    const d = await db();
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    const rows = await tx(d, 'chunks', 'readonly', s => s.getAll(range));
    rows.sort((a, b) => a.seq - b.seq);
    const total = rows.reduce((a, r) => a + r.buf.byteLength / 4, 0);
    const out = new Float32Array(total);
    let pos = 0;
    for (const r of rows) { const f = new Float32Array(r.buf); out.set(f, pos); pos += f.length; }
    return out;
}

export async function getSession(id) {
    const d = await db();
    return tx(d, 'sessions', 'readonly', s => s.get(id));
}

export async function deleteSession(id) {
    const d = await db();
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    await tx(d, 'chunks', 'readwrite', s => s.delete(range));
    await tx(d, 'sessions', 'readwrite', s => s.delete(id));
}

export async function deleteAllSessions() {
    const d = await db();
    await tx(d, 'chunks', 'readwrite', s => s.clear());
    await tx(d, 'sessions', 'readwrite', s => s.clear());
}

/** Encode Float32 PCM @16 kHz as a 16-bit WAV Blob (for download/recovery). */
export function pcmToWavBlob(float32, sampleRate = 16000) {
    const n = float32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
        const x = Math.max(-1, Math.min(1, float32[i]));
        v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}
