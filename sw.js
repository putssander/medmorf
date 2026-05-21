// MedMorf Service Worker — caches app shell and CDN dependencies for offline use.
// Model weights are stored separately in IndexedDB (WebLLM) and Cache API (Transformers.js).
// This SW ensures the JavaScript *libraries* that read those weights are also available offline.

const CACHE_NAME = 'medmorf-app-v1';

// App shell files (local)
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './security.js',
    './app.js',
    './anonymize-handler.js',
    './summarize-handler.js',
    './stt-handler.js',
    './cache-manager.js',
    './privacy-runtime.js',
    './translation-runtime.js',
    './excel-handler.js',
    './word-handler.js',
    './pdf-handler.js',
    './stubs/empty-module.js',
    './stubs/null-module.js',
];

// CDN dependencies that must be available offline
const CDN_DEPS = [
    // Import-map entries
    'https://cdn.jsdelivr.net/npm/@huggingface/jinja@0.5.3/dist/index.js',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/ort.all.min.mjs',
    'https://cdn.jsdelivr.net/npm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/dist/esm/index.js',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.js',
    // Script-tag libs
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs',
    // Dynamic imports
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.82/lib/index.js',
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
];

// Hostnames that should use cache-first strategy (versioned CDN resources)
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'esm.sh'];

// Hostnames where WebLLM/Transformers.js store model files in their own caches
// We intercept these to serve from any cache (including WebLLM's own caches) when offline
const MODEL_HOSTS = ['huggingface.co'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Cache app shell
            await cache.addAll(APP_SHELL);
            // Cache CDN deps individually — don't let one failure block the rest
            await Promise.allSettled(
                CDN_DEPS.map(url => cache.add(url).catch(err => {
                    console.warn('[SW] failed to pre-cache', url, err.message);
                }))
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(
                names
                    .filter(name => name.startsWith('medmorf-app-') && name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // CDN resources: cache-first (they have versioned URLs, safe to serve from cache)
    if (CDN_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                // Not in cache yet — fetch, cache for next time, return
                return fetch(event.request).then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // Model files (huggingface.co): network-first, but search ALL caches as fallback
    // WebLLM/Transformers.js store model weights in their own named caches
    if (MODEL_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
        event.respondWith(
            fetch(event.request).then(response => {
                return response;
            }).catch(async () => {
                // Offline — search all caches for this request
                const names = await caches.keys();
                for (const name of names) {
                    const cache = await caches.open(name);
                    const match = await cache.match(event.request);
                    if (match) return match;
                }
                return new Response('Offline and not cached', { status: 503 });
            })
        );
        return;
    }

    // Local app files: network-first with cache fallback
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }
});
