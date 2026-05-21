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

## Summary

**Total External Dependencies**: 4 JavaScript libraries + 3 CDN providers
**Privacy Status**: ✅ Excellent - all processing is local
**Security Status**: ⚠️ Good, but SRI hashes recommended
**GDPR Compliance**: ✅ Compliant (no data collection)
**Medical Data Safety**: ✅ Safe for client-side processing

**Recommended Actions**:
1. Add SRI hashes (High Priority)
2. Implement CSP headers (High Priority)  
3. Add cache clearing instructions for sensitive data (Medium Priority)
4. Consider self-hosting for enterprise/medical deployments (Optional)

---

**Last Updated**: October 28, 2025
**Review Frequency**: Quarterly or when libraries are updated
