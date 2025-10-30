# Medmorf Privacy & Security Documentation

## 🔒 Privacy Guarantee

**Medmorf is 100% privacy-first. Your healthcare data NEVER leaves your browser.**

---

## What Data is Collected?

### ❌ We Collect ZERO Data

Medmorf collects, stores, or transmits **ZERO** user data:

- ❌ No files uploaded to servers
- ❌ No translation text sent anywhere  
- ❌ No patient information stored
- ❌ No user accounts or login
- ❌ No cookies (except necessary browser cache)
- ❌ No analytics or tracking
- ❌ No IP address logging
- ❌ No usage statistics
- ❌ No crash reports containing user data

### ✅ What Happens to Your Data

1. **File Upload**: File stays in browser memory only
2. **Translation**: Processed entirely in your browser using local ML models
3. **Download**: File saved directly to your device
4. **After Use**: Data cleared from memory when you close the tab

---

## Technical Architecture

### How It Works (No Server Involvement)

```
Your Device (Browser)
├── 1. Upload file → Stays in browser RAM
├── 2. Process with ML model → Runs in browser
├── 3. Translate/process → All local
└── 4. Download result → Saved to your device

NO network transmission of your data ✅
```

### External Connections (Libraries Only)

The ONLY external connections made are:

1. **First Time Only**: Download ML model (~300MB) from Hugging Face CDN
   - Model file contains NO user data
   - Cached locally after first download
   - Can work offline after initial download

2. **Page Load**: Load JavaScript libraries from CDNs:
   - Transformers.js (ML library)
   - SheetJS (Excel processing)
   - FileSaver.js (File downloads)
   - Mammoth.js (Word processing)

These libraries run in YOUR browser and process YOUR data locally.

---

## Browser Storage

### What's Stored in Browser?

| Storage Type | What's Stored | Contains User Data? |
|--------------|---------------|---------------------|
| IndexedDB | ML model files (cached) | ❌ No - only model weights |
| LocalStorage | None | ❌ No |
| SessionStorage | None | ❌ No |
| Cookies | None | ❌ No |
| Browser Cache | Library files, model files | ❌ No |
| Memory (RAM) | Your files during processing | ⚠️ Yes - but cleared when done |

### Clearing Browser Data

For maximum security with sensitive healthcare data:

```javascript
// Manual clearing options:

// 1. Use the "Clear All Data" button in the app

// 2. Console command:
window.medmorfSecurity.clearAll()

// 3. Browser settings:
// - Chrome: Settings → Privacy → Clear browsing data
// - Firefox: Settings → Privacy → Clear Data
// - Safari: Safari → Clear History

// 4. Close browser completely when done
```

---

## Healthcare Data Compliance

### GDPR Compliance

✅ **Fully Compliant** - No personal data processing on servers

- **Right to Access**: Not applicable - no data stored
- **Right to Deletion**: Not applicable - no data stored  
- **Right to Portability**: Not applicable - no data stored
- **Data Processing Agreement**: Not needed - no processing on servers
- **Consent**: Not required - no data collection

### HIPAA Considerations

✅ **Suitable for HIPAA Environments** when used correctly:

- ✅ No PHI transmission over networks
- ✅ No PHI storage on external servers
- ✅ Processing happens on user's device only
- ⚠️ **User Responsibilities**:
  - Use on secured, encrypted devices
  - Use HTTPS connection (GitHub Pages provides this)
  - Clear browser data after processing sensitive data
  - Don't use on shared/public computers
  - Use private/incognito mode for sensitive data

### Additional Healthcare Standards

- **ISO 27001**: No data handling = No compliance issues
- **SOC 2**: Not applicable - no service provider data handling
- **HITRUST**: Client-side processing only

---

## Security Measures

### 1. No Network Transmission
```javascript
// We monitor for any network requests
// If user data were transmitted, console would warn
// Check browser DevTools → Network tab - only library/model downloads
```

### 2. Memory Clearing
```javascript
// Data cleared on:
- Window close
- Tab close  
- Manual "Clear Data" button
- Browser cache clear
```

### 3. HTTPS Only
- All CDN resources loaded over HTTPS
- GitHub Pages forces HTTPS
- No mixed content

### 4. Subresource Integrity (SRI)
```html
<!-- Libraries verified with cryptographic hashes -->
<script src="..." integrity="sha384-..." crossorigin="anonymous"></script>
```

### 5. Content Security Policy
```http
<!-- Only allow resources from trusted CDNs -->
Content-Security-Policy: default-src 'self' cdn.jsdelivr.net cdnjs.cloudflare.com huggingface.co
```

---

## Best Practices for Healthcare Data

### ✅ Recommended Usage

1. **Use Private/Incognito Mode**
   - Chrome: Ctrl+Shift+N / Cmd+Shift+N
   - Firefox: Ctrl+Shift+P / Cmd+Shift+P
   - Safari: Cmd+Shift+N

2. **Clear Data After Each Use**
   - Click "Clear All Data Now" button
   - Close browser completely

3. **Use on Secure Devices**
   - Encrypted hard drive
   - Password-protected device
   - Updated operating system
   - Antivirus software

4. **Verify No Network Activity**
   - Open DevTools (F12)
   - Go to Network tab
   - Should only see CDN requests for libraries

### ❌ Do NOT Use For

1. ❌ Public computers
2. ❌ Shared workstations without clearing data
3. ❌ Unsecured Wi-Fi networks (though data doesn't transmit anyway)
4. ❌ Outdated browsers with security vulnerabilities

---

## Verification Steps

### How to Verify Privacy Yourself

1. **Check Network Activity**:
```javascript
// Open Browser Console (F12)
// Run these commands:

// Show privacy report
window.medmorfSecurity.getPrivacyReport()

// Show privacy warnings
window.medmorfSecurity.showWarnings()

// Check for network requests
// Go to Network tab - should only see:
// - CDN library loads
// - ML model download (first time only)
// - NO requests containing your file data
```

2. **Inspect Source Code**:
   - All source code is public: https://github.com/putssander/medmorf
   - Search for `fetch`, `XMLHttpRequest`, `ajax` - none send user data
   - Review `app.js` - all processing is local

3. **Use Network Monitor**:
   - Tools like Wireshark can monitor actual network packets
   - Will show NO data transmission except CDN downloads

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     Your Browser                         │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│  │  Upload  │───▶│ Process  │───▶│ Download │         │
│  │   File   │    │ Locally  │    │   File   │         │
│  └──────────┘    └──────────┘    └──────────┘         │
│                         │                               │
│                         ▼                               │
│                  ┌──────────┐                          │
│                  │ Clear on │                          │
│                  │   Exit   │                          │
│                  └──────────┘                          │
└─────────────────────────────────────────────────────────┘
        ▲                                    │
        │                                    │
        │ (First time only)                 │
        │ ML Model Download                 │
        │ ~300MB, cached                    │
        │                                    ▼
┌───────────────────┐                ┌──────────────┐
│  Hugging Face CDN │                │ Your Device  │
│   (Model Files)   │                │  (Downloads) │
└───────────────────┘                └──────────────┘

❌ NO data transmission to servers
❌ NO cloud processing
❌ NO data storage
```

---

## Third-Party Services

### CDN Providers (Library Delivery Only)

1. **jsDelivr** (Transformers.js)
   - Privacy: https://www.jsdelivr.com/privacy-policy-jsdelivr-net
   - What they see: Your IP address accessing library files
   - What they DON'T see: Your uploaded files or translations

2. **Cloudflare CDN** (xlsx, FileSaver, Mammoth)
   - Privacy: https://www.cloudflare.com/privacypolicy/
   - What they see: Your IP address accessing library files
   - What they DON'T see: Your uploaded files or translations

3. **Hugging Face** (ML Models)
   - Privacy: https://huggingface.co/privacy
   - What they see: Your IP address downloading model (first time)
   - What they DON'T see: Your uploaded files or translations

**Important**: CDNs deliver JavaScript libraries and ML models. They never see your actual data.

---

## Open Source Transparency

### Full Source Code Available

- **Repository**: https://github.com/putssander/medmorf
- **License**: Open source (check LICENSE file)
- **Audit**: Anyone can review the code
- **Contributions**: Community can verify security

### Security Auditing

Anyone can audit the code:
```bash
# Clone repository
git clone https://github.com/putssander/medmorf.git

# Search for network requests
grep -r "fetch\|XMLHttpRequest\|ajax" *.js

# Search for data storage
grep -r "localStorage\|sessionStorage\|cookie" *.js

# You'll find NO user data transmission or storage!
```

---

## Contact & Questions

### Reporting Security Issues

If you discover a security vulnerability:
1. **Do NOT** open a public GitHub issue
2. Report privately to repository owner
3. We'll address it immediately

### Questions About Privacy

For privacy-related questions:
- Open a GitHub issue (non-sensitive questions)
- Check documentation in repository

---

## Updates & Changes

This privacy policy is versioned with the code:
- **Last Updated**: October 30, 2025
- **Version**: 1.0.0
- **Changes**: Initial release

Any changes to privacy policy will be:
1. Committed to GitHub repository
2. Tagged with version number
3. Announced in README

---

## Summary

### ✅ What Medmorf IS:
- 100% browser-based translation tool
- Zero data collection
- Zero server involvement  
- Open source and auditable
- Privacy-first by design

### ❌ What Medmorf is NOT:
- NOT a cloud service
- NOT collecting your data
- NOT storing your files
- NOT tracking your usage
- NOT sharing data with third parties (because we never have it!)

**Bottom Line**: Your healthcare data is as safe as the device you're using. We never see it, store it, or transmit it. Period.

---

**For Healthcare Professionals**: Medmorf is suitable for processing patient data as long as you follow standard device security practices (encrypted devices, secure browsers, clearing data after use). Since no data leaves your device, there's no HIPAA breach risk from the application itself.

**Certification**: While Medmorf itself doesn't require certification (it's a client-side tool), it's designed to support HIPAA-compliant workflows by ensuring data never leaves secured devices.
