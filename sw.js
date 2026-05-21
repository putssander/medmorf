// MedMorf Service Worker — caches app shell and CDN dependencies for offline use.
// Model weights are stored separately in IndexedDB (WebLLM) and Cache API (Transformers.js).
// This SW ensures the JavaScript *libraries* that read those weights are also available offline.

const CACHE_NAME = 'medmorf-app-v9';

// App shell files (local)
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './styles/styles.css',
    './styles/brand.css',
    './src/security.js',
    './src/app.js',
    './src/anonymize-handler.js',
    './src/summarize-handler.js',
    './src/stt-handler.js',
    './src/cache-manager.js',
    './src/privacy-runtime.js',
    './src/translation-runtime.js',
    './src/device-capabilities.js',
    './src/pre-flight-warn.js',
    './src/lifecycle-manager.js',
    './src/excel-handler.js',
    './src/word-handler.js',
    './src/pdf-handler.js',
    './src/pdf-anonymize-handler.js',
    './src/dicom-handler.js',
    './src/stubs/empty-module.js',
    './src/stubs/null-module.js',
    // Brand assets
    './assets/brand/icon-mark.svg',
    './assets/brand/favicon.svg',
    './assets/brand/favicon-light.svg',
    './assets/brand/apple-touch-icon.svg',
    './assets/brand/icon-192.svg',
    './assets/brand/icon-512.svg',
    './assets/brand/logo-horizontal.svg',
    './assets/brand/logo-horizontal-dark.svg',
    './assets/brand/safari-pinned-tab.svg',
];

// CDN dependencies that must be available offline
const CDN_DEPS = [
    // Import-map entries
    'https://cdn.jsdelivr.net/npm/@huggingface/jinja@0.5.6/dist/index.js',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.all.min.mjs',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.webgpu.min.mjs',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.wasm.min.mjs',
    'https://cdn.jsdelivr.net/npm/onnxruntime-common@1.24.0-dev.20251116-b39e144322/dist/esm/index.js',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js',
    // Script-tag libs
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs',
    // Dynamic imports
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/lib/index.js',
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
    // Brand: Tailwind + fonts
    'https://cdn.tailwindcss.com?plugins=forms,typography',
    'https://rsms.me/inter/inter.css',
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
];

// Hostnames that should use cache-first strategy (versioned CDN resources)
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.tailwindcss.com', 'rsms.me', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Hostnames where WebLLM/Transformers.js store model files in their own caches
// We intercept these to serve from any cache (including WebLLM's own caches) when offline
const MODEL_HOSTS = ['huggingface.co'];

// Allow page to trigger immediate activation of a new SW
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

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
