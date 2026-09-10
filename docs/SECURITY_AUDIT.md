# Medmorf - External Libraries Security Audit

## Overview
This document lists all external libraries and CDN resources used in Medmorf for security verification and privacy compliance.

---

## JavaScript Libraries (Browser)

### 1. Transformers.js
- **Source**: `https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2`
- **Purpose**: Run Hugging Face ML models in browser for translation
- **Version**: 2.17.2
- **License**: Apache-2.0
- **GitHub**: https://github.com/xenova/transformers.js
- **Privacy Impact**: 
  - ✅ Runs entirely in browser
  - ✅ No data sent to external servers
  - ⚠️ First use downloads model files (~300MB) from Hugging Face CDN
  - ✅ Model cached locally in browser after first download
- **Security Considerations**:
  - Loaded from jsDelivr CDN
  - Consider using Subresource Integrity (SRI) hash
  - Review transformers.js source code
- **Data Flow**: User data → Browser only (local processing)

### 2. SheetJS (xlsx)
- **Source**: `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`
- **Purpose**: Read and write Excel (.xlsx) files
- **Version**: 0.18.5
- **License**: Apache-2.0
- **GitHub**: https://github.com/SheetJS/sheetjs
- **Privacy Impact**:
  - ✅ Runs entirely in browser
  - ✅ No data sent to external servers
  - ✅ All file processing is local
- **Security Considerations**:
  - Loaded from Cloudflare CDN
  - Consider using SRI hash
  - Well-established library with large user base
- **Data Flow**: Excel files → Browser only (local processing)

### 3. FileSaver.js
- **Source**: `https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js`
- **Purpose**: Save files from browser to user's device
- **Version**: 2.0.5
- **License**: MIT
- **GitHub**: https://github.com/eligrey/FileSaver.js
- **Privacy Impact**:
  - ✅ Runs entirely in browser
  - ✅ Only triggers browser download
  - ✅ No external connections
- **Security Considerations**:
  - Loaded from Cloudflare CDN
  - Simple library, minimal attack surface
- **Data Flow**: Browser → User's local filesystem only

### 4. Mammoth.js
- **Source**: `https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js`
- **Purpose**: Extract text from Word (.docx) files
- **Version**: 1.6.0
- **License**: BSD-2-Clause
- **GitHub**: https://github.com/mwilliamson/mammoth.js
- **Privacy Impact**:
  - ✅ Runs entirely in browser
  - ✅ No data sent to external servers
  - ✅ All file processing is local
- **Security Considerations**:
  - Loaded from Cloudflare CDN
  - Consider using SRI hash
  - Review for potential ZIP/XML parsing vulnerabilities
- **Data Flow**: Word files → Browser only (local processing)

---

## Python Libraries (Test File Generation)

### 1. openpyxl
- **Source**: PyPI
- **Purpose**: Create test Excel files (development only)
- **Version**: Latest (installed via pip)
- **License**: MIT
- **PyPI**: https://pypi.org/project/openpyxl/
- **Privacy Impact**: 
  - ✅ Not used in production
  - ✅ Only for creating test files
- **Security Considerations**:
  - Development dependency only
  - Not included in deployed application

---

## CDN Providers

### 1. jsDelivr
- **URLs Used**: 
  - `https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2`
- **Privacy Policy**: https://www.jsdelivr.com/privacy-policy-jsdelivr-net
- **Security**: 
  - HTTPS only
  - Consider self-hosting for maximum control
- **Data Collection**: May collect anonymous usage statistics

### 2. Cloudflare CDN (cdnjs)
- **URLs Used**:
  - `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`
  - `https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js`
  - `https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js`
- **Privacy Policy**: https://www.cloudflare.com/privacypolicy/
- **Security**:
  - HTTPS only
  - Reliable CDN with DDoS protection
- **Data Collection**: May collect IP addresses and usage logs

### 3. Hugging Face CDN
- **Purpose**: Model file downloads (automatic, first use only)
- **URLs**: `https://huggingface.co/Xenova/nllb-200-distilled-600M`
- **Privacy Policy**: https://huggingface.co/privacy
- **Security**: HTTPS only
- **Data Collection**: 
  - May log download requests
  - Files cached locally after first download
- **Model Size**: ~300MB (one-time download)

---

## Security Recommendations

### High Priority
1. **Add Subresource Integrity (SRI) hashes** to all CDN scripts
   - Prevents tampering with CDN resources
   - Example: `<script src="..." integrity="sha384-..." crossorigin="anonymous"></script>`

2. **Content Security Policy (CSP)**
   - Define which domains can load resources
   - Prevent XSS attacks
   - Example CSP headers needed for current setup

3. **Self-hosting consideration**
   - For maximum security, host all libraries yourself
   - Eliminates dependency on external CDNs
   - Requires ~2-3MB additional hosting space (excluding model)

### Medium Priority
4. **Regular dependency updates**
   - Monitor for security updates
   - Check GitHub security advisories

5. **Model integrity verification**
   - Verify Hugging Face model checksums
   - Consider hosting model files yourself for critical deployments

### Best Practices
6. **No analytics or tracking**
   - ✅ Currently implemented - no Google Analytics, no trackers
   - ✅ No cookies set by the application

7. **HTTPS only**
   - ✅ Currently implemented - all CDN URLs use HTTPS
   - Ensure GitHub Pages forces HTTPS

---

## Privacy Compliance

### GDPR Compliance
- ✅ **No personal data collection**: Application doesn't collect, store, or transmit user data
- ✅ **Local processing**: All translation/processing happens in browser
- ✅ **No cookies**: No tracking cookies used
- ⚠️ **CDN logging**: CDN providers may log requests (IP addresses)
- ✅ **Right to be forgotten**: Not applicable - no data stored
- ✅ **Data portability**: Not applicable - no data stored

### HIPAA Considerations (Medical Data)
- ✅ **No data transmission**: Patient data never leaves browser
- ✅ **No server processing**: All processing is client-side
- ✅ **No logging**: Application doesn't log patient data
- ⚠️ **User responsibility**: Users must ensure browser security
- ⚠️ **Cache consideration**: Browsers may cache translated files locally
- 📝 **Recommendation**: Add warning about browser cache for sensitive data

---

## Verification Steps

### For Each Library:
1. ✅ Verify license compatibility (all are permissive: Apache-2.0, MIT, BSD-2-Clause)
2. ⚠️ Check for known CVEs (Common Vulnerabilities and Exposures)
3. ⚠️ Generate and add SRI hashes
4. ⚠️ Review each library's source code on GitHub
5. ✅ Confirm no unexpected network requests (currently none)

### Security Testing:
1. ⚠️ Run browser DevTools Network tab during use - verify no unexpected requests
2. ⚠️ Test with browser offline mode (after model download) - should work
3. ⚠️ Review JavaScript Console for errors or warnings
4. ⚠️ Test file upload/download with malformed files
5. ⚠️ XSS testing on user inputs

---

## How to Generate SRI Hashes

```bash
# For SheetJS
curl -s https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js | \
  openssl dgst -sha384 -binary | openssl base64 -A

# For FileSaver.js
curl -s https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js | \
  openssl dgst -sha384 -binary | openssl base64 -A

# For Mammoth.js
curl -s https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js | \
  openssl dgst -sha384 -binary | openssl base64 -A
```

Note: Transformers.js is loaded as ES module and SRI support for modules is limited.

---

## Alternative: Self-Hosted Setup

To eliminate all external dependencies:

1. Download all libraries
2. Host on your own server/GitHub Pages
3. Update script tags to local paths
4. Host ML model files (requires ~300MB storage)

Benefits:
- ✅ Complete control over all assets
- ✅ No CDN dependencies
- ✅ Faster loading (no external requests)
- ✅ Works completely offline

Drawbacks:
- ❌ More maintenance overhead
- ❌ Need to manually update libraries
- ❌ Larger repository size

---

## Outbound data audit — 2026-09-10

**Question audited:** can any user data (documents, pasted text, audio, transcripts, detected identifiers, mappings) leave the browser? **Answer: no.** Every remote request the app makes is a `GET` for code, fonts or model files whose URL contains nothing but a library or model name.

**Scope and method.** All first-party code (`src/*.js`, `sw.js`, `index.html`, `manifest.webmanifest`) was searched for every network and navigation primitive (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `navigator.share`, `postMessage`, `window.open`, `location`/history writes, `<form>`, dynamic `import()`, `.src =`). Each request was classified by host and payload. The third-party bundles as delivered by the CDNs on 2026-09-10 (WebLLM 0.2.83, Transformers.js 4.2.0 and 2.17.2, gliner 0.0.19, onnxruntime-web 1.19.2 and 1.26, tesseract.js 5, Tailwind Play CDN) were downloaded and searched for hostnames and telemetry keywords. The service worker was read in full. The anonymize and benchmark paths were exercised in headless Chrome.

### Every remote host, and what is sent to it

| Host | When | What leaves the browser |
| --- | --- | --- |
| `cdn.jsdelivr.net` | page load / first use of a feature | `GET` of pinned library versions (Transformers.js, ONNX runtime, WebLLM, pdf.js, pdf-lib, tesseract.js) |
| `cdnjs.cloudflare.com` | page load | `GET` of xlsx, FileSaver, mammoth |
| `cdn.tailwindcss.com` | page load | `GET` of the Tailwind Play script (it runs in the page and makes no requests of its own) |
| `esm.sh` | GLiNER detector selected | `GET` of the gliner package and its onnxruntime-web 1.19.2 |
| `huggingface.co` (redirects to its LFS/CDN hosts) | model download | `GET` of model weights, configs and tokenizers; the URL names the model only. One extra `GET` of `mlc-chat-config.json` checks reachability before a multi-GB download |
| `raw.githubusercontent.com` | WebLLM model load | `GET` of the model's WebGPU WASM library (mlc-ai/binary-mlc-llm-libs) |
| `tessdata.projectnaptha.com` | OCR of scanned PDFs | `GET` of language data |
| `rsms.me`, `fonts.googleapis.com`, `fonts.gstatic.com` | page load | `GET` of fonts |
| same origin | page load, examples, Benchmark tab | app shell, example documents, synthetic fixtures |

Like any CDN, these hosts observe the visitor's IP address and user agent. They do not receive the page URL: `index.html` now carries `<meta name="referrer" content="no-referrer">` (the `Referrer-Policy` header in `_headers` only applies on Cloudflare Pages, not GitHub Pages).

**Not present anywhere:** `POST`/`PUT` requests, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, form submissions, `navigator.share`, cross-origin `postMessage`, share targets in the manifest, remote pdf.js font/cMap fetches. URL query strings are read-only feature flags (`?anon-debug=1`, `?stt-*=1`); the app never writes user data into the URL or the history. `postMessage` is used only towards the app's own service worker (`SKIP_WAITING`) and an in-page AudioWorklet.

### Third-party bundles

Hostnames referenced inside the delivered code: WebLLM → `huggingface.co`, `raw.githubusercontent.com`; Transformers.js → `huggingface.co`, `cdn.jsdelivr.net`; gliner → `cdn.jsdelivr.net`; onnxruntime-web → none; tesseract.js → `cdn.jsdelivr.net`; Tailwind Play → none at runtime (documentation links only). No bundle contains `sendBeacon`, analytics, telemetry, PostHog, Sentry, Mixpanel or Segment code.

### Service worker

`sw.js` handles `GET` only and has three branches: CDN hosts cache-first, `huggingface.co` network-first with cache fallback, same-origin network-first with cache fallback. It never rewrites a destination, adds a request, or contacts another host; all caches are local to the browser.

### Local persistence (stays on the device; listed for completeness)

- `localStorage`: model choices, "don't ask again" per model, an STT crash-stage breadcrumb (stage name and model id, no content).
- IndexedDB `medmorf-stt-recovery`: raw audio chunks and partial transcripts while recording/transcribing, so a killed tab loses nothing; deleted after a successful transcription, by *Discard*, and by Storage → *Delete all*.
- Cache API / IndexedDB model caches: weights only.
- In-memory user data is cleared on tab close, refresh, navigation and after 30 minutes of inactivity.

### Logging

Detector and LLM debugging used to print detected entities and raw model output to the browser console. Since 2026-09-10 those lines are gated behind `?anon-debug=1`, so identifiers do not end up in DevTools logs or screenshots. Remaining console output is status and error text without document content. The Benchmark tab's log shows model output for the synthetic fixtures only.

### Findings

1. **No path sends user data off the device.** ✅
2. Hardening applied with this audit: `no-referrer` meta tag; identifier-bearing console output gated behind the debug flag.
3. Residual risks, unchanged and outside "data going out":
   - **CDN-hosted code without SRI** (existing high-priority item): a compromised CDN could serve altered code. URLs are version-pinned; the ES-module builds (WebLLM, Transformers.js) load further files dynamically, which SRI cannot cover, so self-hosting is the robust fix.
   - **Fonts from Google and rsms.me** expose visitor IPs to those hosts; self-hosting the two fonts removes them.
   - **Tailwind Play CDN** executes a remote script at load; a built stylesheet would remove one remote code source.
   - **No Content-Security-Policy.** A `connect-src` allowlist naming the hosts above would make this guarantee browser-enforced rather than review-based. Note that Hugging Face downloads redirect to its LFS/CDN hosts, which must be included or model downloads break; test on both deployments before enabling.

### How to re-verify yourself

Open DevTools → Network before loading a document, tick *Preserve log*, run Anonymize / Speech / Summarize, then filter by method: there must be no request other than `GET`, and every `GET` must go to a host in the table above with a URL that contains no part of your document. `docs/PRIVACY_VERIFICATION.md` has the full checklist.

## Summary

**Total External Dependencies**: 9 JavaScript libraries / runtimes + 5 CDN or model hosts (see the 2026-09-10 outbound data audit above)
**Privacy Status**: ✅ Excellent - all processing is local; outbound traffic is `GET` of code and model files only (audited 2026-09-10)
**Security Status**: ⚠️ Good, but SRI hashes recommended
**GDPR Compliance**: ✅ Compliant (no data collection)
**Medical Data Safety**: ✅ Safe for client-side processing

**Recommended Actions**:
1. Add SRI hashes (High Priority)
2. Implement CSP headers (High Priority)  
3. Add cache clearing instructions for sensitive data (Medium Priority)
4. Consider self-hosting for enterprise/medical deployments (Optional)

---

**Last Updated**: September 10, 2026 (outbound data audit added; library list of the 2025 sections is historical)
**Review Frequency**: Quarterly or when libraries are updated
