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

### Planned (not implemented): optional local Ollama backend

A future opt-in setting under **Advanced settings → LLM** in the Anonymize and Summarize tabs will let the app use a locally installed [Ollama](https://ollama.com) for the language-model step. This changes nothing above unless the user switches it on:

- Off by default; nothing in the app contacts Ollama today.
- When on, the only new connection is to the Ollama process on the **same computer** (`http://localhost:11434`). No data leaves the machine. The app will never accept a remote server address for this.
- Because medmorf.com is not a localhost page, Ollama must be told to trust it (`OLLAMA_ORIGINS=https://medmorf.com`, see the README roadmap section). Chrome will also ask once whether the site may reach devices on the local network.
- Not available on iPhone/iPad.

This section will be rewritten as a description of shipped behaviour when the feature lands; until then the sentence "no network transmission of your data" holds without exception.

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


## Data prompt builder

Selected tabular files are read and parsed locally in browser memory, not uploaded or saved in browser storage. The browser’s folder-picker dialog may use “upload” or site-trust language to describe granting access to the selected files; this is browser-owned wording. Cancelling the picker leaves the current local analysis unchanged. Phase 1 needs no model: it exports measured descriptors only, with column headers, row counts and per-column statistics included by default in the workspace. Users may withhold headers/statistics using the column switches and must review the prompt before copying/saving. Phase 2 adds optional descriptions, generation rules, a brief, examples and unverified harmonisation suggestions. Choosing Phase 1 excludes all Phase 2 additions even after a model run. Terminology suggestions are not verified mappings; no external terminology service is contacted. The optional Qwen3.5 2B assistant receives local column headers, aggregate statistics and bounded source-cell samples (only cells from the first five data rows per table, truncated to 120 UTF-16 code units each; no backfilling from later rows); it runs through WebLLM in this browser. Its dependency/model downloads contain no dataset payload. No frontier-model API is connected. Offline use requires prior caching of libraries and the optional model.

Both prompt phases include stable table aliases, editable table names and original column headers by default. Table names initially use the CSV/TSV/JSON filename without its extension or the XLSX worksheet name. Replace identifying parts in each table’s Table name in prompt field, or clear it to use only its generic alias as the name. AI does not overwrite this field; edits reset export review. Each column name can be disabled to use its alias. Source sample rows and folder paths are excluded; observed text-value summaries may be included when both their per-column toggle and Statistics are enabled; filename-derived table names are included unless replaced or cleared. Headers can themselves identify people or organisations and must be reviewed. Users can control original column names per column, include each column's aggregate statistics and add descriptions; these may still contain identifying information, particularly exact ranges or small groups. The feature does not certify anonymization. The user-triggered local AI action fills empty editable description/rule fields and the generation brief with drafts; manual edits are preserved; untouched previous AI drafts can be refreshed. Those drafts enter only the Phase 2 editable prompt, but copying/saving still requires explicit review of the exact prompt. AI cannot enable export switches or alter calculated measurements. Bounded source-cell samples enter local model messages; private ID comparison sets do not. Samples stay in a private in-memory WeakMap, outside serialization and direct exports, and are discarded on replacement or cleanup. Despite instructions to generalize, model-generated descriptions can repeat sensitive details and must be reviewed. Saving/copying requires reviewing the current prompt. A manual paste into an external service is a separate disclosure chosen by the user. Source files and profiles are not stored in browser persistence; global sensitive-state cleanup clears the tab. Downloaded prompts and clipboard contents remain until users remove them outside Medmorf.


Text-column structural analysis uses fixed descriptions and fixed fictional examples, never paraphrases or retained excerpts. It reports formatting heuristics only when observed in at least five non-empty cells, with coarse prevalence labels. No source names, organisations, locations, numbers or other tokens are extracted into this profile. Patterns and examples require a separate per-column export opt-in. Suppressing rare patterns is not a privacy guarantee; the feature does not establish semantic meaning or detect all identifiers. User-written descriptions, enabled headers, numeric summaries and directly edited prompts still require review.


Before AI enrichment, synthetic example rows use fixed fictional text and generated numeric candidates. Phase 2 additionally asks the local model to propose minimal column groups and three meaning-based examples per column, aligned within related groups. Planning uses headers/types and at most two existing first-five-row snippets per column. All inference stays local. Model examples are checked against the full source column locally for normalized collisions, type, numeric range and text length before use; a failed check prompts one repair. Real-category alternatives are allowed, but no terminology lookup or semantic/cross-column validation is performed. Plans and examples require review, and are excluded from Phase 1. These checks do not detect all identifying details or paraphrases. Normalized source-column comparison sets remain in a private in-memory WeakMap to support changing identifier formats. They are never serialized, exported, sent to a model or persisted; replacement and sensitive-state cleanup discard them. Candidate values and eligible fixed generic labels also remain. Boolean, binary 0/1 and empty values are exceptions; generic labels require explicit approval. A separate switch includes the preview in the prompt. These checks prevent normalized cell-value matches for non-exempt columns, not re-identification or full-dataset similarity. They do not certify anonymity or clinical validity. Numeric exhaustion blocks the preview. Clearing the analysis also discards its synthetic candidates.

Identifier masks produce three distinct strings and reject normalized matches with their source column, preserving leading zeros. No original identifier or substring is used as a generated prefix; literal prefixes come only from the user-entered format. Formats themselves appear in the prompt and should be reviewed. Checks are limited to each source column, not external databases or cross-table identity.

The content assistant infers likely broad topics, row meaning and text challenges from limited samples, not a comprehensive or representative read. It is instructed to omit names, organisations, locations, identifiers, exact dates and rare events, but these instructions are not an anonymization guarantee. Samples are local inference inputs, not frontier-model inputs. Export remains a separate user-reviewed action.

Text-value summaries contain actual source strings with frequencies. They default off if any value occurs fewer than five times, there are over 20 distinct values, distinct/non-missing exceeds 20%, or text exceeds 120 Unicode code points. Passing these checks does not establish anonymity: repeated names or other identifiers can still be included. Users can override the default and must review the exact prompt. Summaries retain at most 20 values of up to 120 code points each with truncation and omission metadata, in a private in-memory WeakMap cleared on replacement/cleanup. They are excluded from serialized profiles and do not add to local-model inputs. Turning off Statistics at column, table or analysis level excludes these summaries from either prompt phase.
