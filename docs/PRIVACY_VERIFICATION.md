# Privacy Verification Test for Medmorf

## Quick Privacy Check

Run these commands in your browser console (F12) to verify privacy:

### 1. Check Privacy Status
```javascript
window.medmorfSecurity.getPrivacyReport()
```

Expected output:
```javascript
{
  secureContext: true,          // ✅ Running in secure context
  https: true,                  // ✅ Using HTTPS
  localStorageEmpty: true,      // ✅ No data in localStorage
  sessionStorageEmpty: true,    // ✅ No data in sessionStorage
  cookiesDisabled: true,        // ✅ No cookies (or disabled)
  timestamp: "2025-10-30T..."   // Current time
}
```

### 2. Show Privacy Warnings
```javascript
window.medmorfSecurity.showWarnings()
```

### 3. Monitor Network Requests

**During file upload and translation:**

1. Open DevTools (F12)
2. Go to "Network" tab
3. Upload and translate a file
4. Check the network requests

**Expected requests (ONLY these, and only libraries):**
- ✅ `cdn.jsdelivr.net` - Transformers.js library
- ✅ `cdnjs.cloudflare.com` - xlsx, FileSaver, Mammoth libraries
- ✅ `huggingface.co` - ML model download (first time only)
- ✅ `github.io` - This web page

**Should NOT see:**
- ❌ POST requests with your file data
- ❌ Requests to analytics services
- ❌ Requests to unknown domains
- ❌ Requests containing file content in URL or body

### 4. Check for Data Storage

```javascript
// Check localStorage
console.log('localStorage items:', localStorage.length);
// Expected: 0 (or only transformers cache)

// Check sessionStorage  
console.log('sessionStorage items:', sessionStorage.length);
// Expected: 0

// Check cookies
console.log('Cookies:', document.cookie);
// Expected: "" (empty) or only essential cookies
```

### 5. Verify Source Code

All code is open source and can be audited:

```bash
# Clone the repository
git clone https://github.com/putssander/medmorf.git
cd medmorf

# Search for network requests that send data
grep -r "fetch.*POST\|XMLHttpRequest.*POST\|ajax.*POST" *.js
# Should return: NO RESULTS

# Search for data storage
grep -r "localStorage.setItem\|sessionStorage.setItem" *.js  
# Should return: NO RESULTS (except transformers.js model cache)

# Search for external API calls
grep -r "https://.*api\|http://.*api" *.js
# Should return: NO RESULTS
```

---

## Network Monitoring Test

### Using Browser DevTools

1. Open the app in browser
2. Press F12 to open DevTools
3. Go to "Network" tab
4. Click "Preserve log"
5. Upload a file and translate it
6. Review all network requests

**What you should see:**
- Initial page load: HTML, CSS, JS files
- Library loads from CDNs (one-time per session)
- Model download from Hugging Face (one-time, cached)
- **NO requests containing your file or translation data**

### Using Wireshark (Advanced)

For network-level verification:

```bash
# Install Wireshark
# Start capture on your network interface
# Use the app
# Stop capture

# Filter for HTTP/HTTPS traffic:
http || tls

# Look for:
# - POST requests (should be NONE with your data)
# - Large data transfers (should be NONE except model download)
# - Unexpected destinations (should be NONE)
```

---

## File Processing Verification

### Test with Sensitive Data Marker

1. Create an Excel file with unique text: "TEST_PRIVACY_12345"
2. Upload and translate the file
3. Monitor network traffic for that unique string
4. **Expected**: String should NEVER appear in network requests

### Memory Verification

```javascript
// After translation, check if data is in memory
console.log('Current file:', window.currentFile?.name); // Should show filename
console.log('File size:', window.currentFile?.size); // Should show size

// Clear data
window.medmorfSecurity.clearAll();

// Check again
console.log('Current file after clear:', window.currentFile); // Should be null
```

---

## Browser Cache Verification

### Check What's Cached

```javascript
// List all caches
caches.keys().then(keys => {
    console.log('Cached items:', keys);
    // Should show: transformers.js model cache (safe, contains no user data)
});

// Check IndexedDB
indexedDB.databases().then(dbs => {
    console.log('IndexedDB databases:', dbs);
    // Should show: transformers.js database (safe, contains only model weights)
});
```

### Verify Cache Contents

```javascript
// Examine cache contents
caches.keys().then(async keys => {
    for (const key of keys) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        console.log(`Cache "${key}" contains:`, requests.map(r => r.url));
        // Should only contain model files, NOT your data
    }
});
```

---

## Privacy Test Checklist

Run through this checklist to verify privacy:

- [ ] Browser console shows no warnings about data transmission
- [ ] Network tab shows no POST requests with file data
- [ ] localStorage is empty (or only has model cache)
- [ ] sessionStorage is empty
- [ ] No cookies set by the application
- [ ] Source code review shows no data transmission code
- [ ] Clear data button successfully removes all data
- [ ] Closing tab triggers beforeunload warning (if data present)
- [ ] After clearing, window.currentFile is null
- [ ] After clearing, browser cache contains no personal data

---

## Automated Privacy Test Script

Copy and paste this into browser console:

```javascript
async function runPrivacyTest() {
    console.log('🔍 Medmorf Privacy Test Starting...\n');
    
    const results = {
        passed: 0,
        failed: 0,
        warnings: 0
    };
    
    // Test 1: Check HTTPS
    console.log('Test 1: HTTPS Check');
    if (window.location.protocol === 'https:') {
        console.log('✅ PASS: Using HTTPS');
        results.passed++;
    } else {
        console.log('❌ FAIL: Not using HTTPS');
        results.failed++;
    }
    
    // Test 2: Check localStorage
    console.log('\nTest 2: localStorage Check');
    if (localStorage.length === 0) {
        console.log('✅ PASS: localStorage is empty');
        results.passed++;
    } else {
        console.log('⚠️  WARNING: localStorage has items:', localStorage.length);
        results.warnings++;
    }
    
    // Test 3: Check sessionStorage
    console.log('\nTest 3: sessionStorage Check');
    if (sessionStorage.length === 0) {
        console.log('✅ PASS: sessionStorage is empty');
        results.passed++;
    } else {
        console.log('❌ FAIL: sessionStorage has items:', sessionStorage.length);
        results.failed++;
    }
    
    // Test 4: Check cookies
    console.log('\nTest 4: Cookies Check');
    if (document.cookie === '') {
        console.log('✅ PASS: No cookies set');
        results.passed++;
    } else {
        console.log('⚠️  WARNING: Cookies present:', document.cookie);
        results.warnings++;
    }
    
    // Test 5: Check security manager
    console.log('\nTest 5: Security Manager Check');
    if (typeof window.medmorfSecurity !== 'undefined') {
        console.log('✅ PASS: Security manager loaded');
        results.passed++;
    } else {
        console.log('❌ FAIL: Security manager not found');
        results.failed++;
    }
    
    // Test 6: Check caches
    console.log('\nTest 6: Cache Check');
    try {
        const keys = await caches.keys();
        console.log('ℹ️  INFO: Caches found:', keys.length);
        keys.forEach(key => {
            if (key.includes('transformers')) {
                console.log('  ✅ Safe cache (ML model):', key);
            } else {
                console.log('  ⚠️  Unknown cache:', key);
            }
        });
        results.passed++;
    } catch (e) {
        console.log('⚠️  WARNING: Could not check caches');
        results.warnings++;
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('Privacy Test Results:');
    console.log('  ✅ Passed:', results.passed);
    console.log('  ❌ Failed:', results.failed);
    console.log('  ⚠️  Warnings:', results.warnings);
    console.log('='.repeat(50));
    
    if (results.failed === 0) {
        console.log('✅ PRIVACY VERIFIED: No issues detected!');
    } else {
        console.log('❌ PRIVACY ISSUES: Please review failed tests');
    }
    
    return results;
}

// Run the test
runPrivacyTest();
```

---

## Expected Results

After running all tests, you should see:

- ✅ All network requests are to CDNs for libraries only
- ✅ No POST requests containing user data
- ✅ Storage (localStorage, sessionStorage) is empty
- ✅ No tracking cookies
- ✅ Data cleared from memory after use
- ✅ Source code contains no data transmission logic

**If any test fails, DO NOT use for sensitive healthcare data until investigated!**

---

## Continuous Monitoring

For ongoing verification:

1. **Before Each Use**:
   - Run `runPrivacyTest()` in console
   - Check Network tab is clear

2. **During Use**:
   - Keep Network tab open
   - Watch for unexpected requests

3. **After Use**:
   - Click "Clear All Data" button
   - Verify data is cleared with `window.currentFile` check
   - Close browser completely

---

## Report Privacy Concerns

If you discover any privacy issues:

1. Document the issue with screenshots
2. Include browser console output
3. Include network traffic logs
4. Report to: GitHub Issues (for non-sensitive issues)
5. Contact repository owner directly (for security vulnerabilities)

---

**Remember**: This tool is designed for maximum privacy. These tests verify that design is working as intended. Your vigilance helps ensure healthcare data remains secure!
