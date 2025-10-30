# 🌐 Medmorf - In-Browser Translation Tool

A powerful web-based translation tool that runs entirely in your browser using Hugging Face's Transformers.js and the NLLB-200 translation model. Translate Excel spreadsheets and Word documents without sending your data to any server - all processing happens locally on your device!

## 🚀 Live Demo

**[Try it now: https://putssander.github.io/medmorf/](https://putssander.github.io/medmorf/)**

## ✨ Features

- **🔒 100% Privacy - Healthcare Safe**: All translation happens in your browser - no data leaves your device
  - ✅ Zero data transmission to servers
  - ✅ Zero data storage on our end (we have no servers!)
  - ✅ Zero tracking, cookies, or analytics
  - ✅ GDPR compliant by design
  - ✅ Suitable for HIPAA-compliant workflows
  - ✅ Includes "Clear All Data" button for sensitive data
- **📊 Excel Support**: Upload `.xlsx` files and select specific sheets and columns to translate
- **📝 Word Support**: Upload `.docx` files for full document translation
- **🎯 Multiple Languages**: Support for Dutch, English, German, French, Spanish, Italian, Portuguese, and more
- **📈 Progress Tracking**: Real-time progress bars showing translation status
- **💾 Easy Download**: Download translated files with one click
- **🚀 No Installation**: Just open in a modern web browser and start translating
- **🔍 Verifiable**: Open source - audit the code yourself

## 🚀 Quick Start

### Option 1: Open Directly (Recommended)

1. Download all files to a folder on your computer
2. Open `index.html` in a modern web browser (Chrome, Firefox, Edge, or Safari)
3. That's it! Start translating

### Option 2: Run with Local Server

If you prefer to run a local server:

```bash
# Using Python 3
python -m http.server 8000

# Or using Python 2
python -m SimpleHTTPServer 8000

# Or using Node.js (if you have http-server installed)
npx http-server -p 8000
```

Then open `http://localhost:8000` in your browser.

## 🏥 Healthcare Data Privacy

### Verified Safe for Medical Data

Medmorf is specifically designed for processing sensitive healthcare data:

- **No Server Processing**: All translation happens in YOUR browser using WebAssembly
- **No Data Transmission**: Your files never leave your device
- **No Cloud Services**: We don't have servers - nothing to hack or breach
- **Memory Clearing**: Data automatically cleared when you close the tab
- **Manual Clear**: "Clear All Data" button for immediate data removal
- **Audit Trail**: Open source code anyone can verify
- **Privacy Verification**: Run `window.medmorfSecurity.getPrivacyReport()` in console to verify

### For Healthcare Professionals

✅ **Recommended**:
- Use on encrypted, password-protected devices
- Use private/incognito browser mode
- Clear data after each session
- Close browser when finished
- Verify HTTPS connection (🔒 in address bar)

❌ **Not Recommended**:
- Public or shared computers
- Unencrypted devices
- Outdated browsers

See [PRIVACY.md](PRIVACY.md) for complete privacy documentation.

---

## 📖 How to Use

### Translating Excel Files

1. **Upload**: Click the upload area or drag & drop your `.xlsx` file
2. **Select Sheet**: Choose which sheet contains the data you want to translate
3. **Select Columns**: Check the columns you want to translate
4. **Choose Languages**: Select source and target languages
5. **Translate**: Click "Start Translation"
6. **Download**: Once complete, download the translated file

**Note**: Translated columns will be added as new columns in the output file, preserving your original data.

### Translating Word Documents

1. **Upload**: Click the upload area or drag & drop your `.docx` file
2. **Choose Languages**: Select source and target languages
3. **Translate**: Click "Start Translation"
4. **Download**: Once complete, download the translated text file

**Note**: Currently outputs as plain text. Formatting from the original document is not preserved.

## 🛠️ Technical Details

### Technologies Used

- **[Transformers.js](https://huggingface.co/docs/transformers.js)**: Run Hugging Face models in the browser
- **[NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M)**: Facebook's multilingual translation model (distilled version)
- **[SheetJS](https://sheetjs.com/)**: Excel file reading and writing
- **[Mammoth.js](https://github.com/mwilliamson/mammoth.js)**: Word document text extraction
- **[FileSaver.js](https://github.com/eligrey/FileSaver.js/)**: File download functionality

### Supported Languages

The NLLB-200 model supports translation between 200+ languages. Currently configured languages:

- Dutch (Nederlands) - `nld_Latn`
- English - `eng_Latn`
- German (Deutsch) - `deu_Latn`
- French (Français) - `fra_Latn`
- Spanish (Español) - `spa_Latn`
- Italian (Italiano) - `ita_Latn`
- Portuguese (Português) - `por_Latn`

**Want more languages?** You can easily add more by editing the language dropdowns in `index.html`.

### Model Information

- **Model**: `Xenova/nllb-200-distilled-600M`
- **Size**: ~300MB (downloaded once and cached by your browser)
- **First Use**: The first time you use the tool, it will download the model. This may take a few minutes depending on your internet connection.
- **Subsequent Uses**: The model is cached, so translations start immediately

## ⚡ Performance

- **Speed**: Varies by device and text length. Expect ~0.5-2 seconds per paragraph on modern hardware
- **Memory**: Requires ~2-3GB of available RAM for optimal performance
- **Browser**: Works best on Chrome/Edge (V8 engine optimization)

## 🔧 Customization

### Adding More Languages

Edit `index.html` and add options to the language selectors:

```html
<option value="language_code">Language Name</option>
```

Find language codes in the [NLLB documentation](https://github.com/facebookresearch/flores/blob/main/flores200/README.md#languages-in-flores-200).

### Changing the Translation Model

Edit `app.js` and change the model name:

```javascript
translator = await pipeline('translation', 'Xenova/your-model-name');
```

### Adjusting Batch Size

For Excel files with many cells, you can adjust translation speed vs. memory usage by modifying the batch processing logic in `app.js`.

## 🐛 Troubleshooting

### Model Won't Download

- **Check Internet Connection**: Ensure you have a stable internet connection
- **Clear Browser Cache**: Try clearing your browser's cache and reload
- **Try Different Browser**: Some browsers may have stricter caching policies

### Translation is Slow

- **Close Other Tabs**: Free up memory by closing unused tabs
- **Reduce Batch Size**: Translate smaller sections at a time
- **Use Modern Browser**: Chrome and Edge typically offer best performance

### File Won't Upload

- **Check File Size**: Very large files may cause issues. Try with smaller files first
- **Check File Format**: Ensure files are `.xlsx` or `.docx` format
- **Check File Corruption**: Try opening the file in Excel/Word first

### Translation Quality Issues

- **Source Language**: Ensure you've selected the correct source language
- **Model Limitations**: The distilled model is faster but may be less accurate than full models
- **Context**: Short phrases may translate less accurately than full sentences

## 🔐 Privacy & Security

- ✅ All processing happens in your browser
- ✅ No data is sent to any server
- ✅ No analytics or tracking
- ✅ Works offline after initial model download
- ✅ Open source - inspect the code yourself

## 📝 File Structure

```
.
├── index.html           # Main HTML interface
├── app.js              # Main application logic and translation
├── styles.css          # Styling and responsive design
├── excel-handler.js    # Excel file processing utilities
├── word-handler.js     # Word document processing utilities
└── README.md           # This file
```

## 🤝 Contributing

Feel free to:
- Report bugs
- Suggest features
- Submit pull requests
- Share with others

## 📄 License

This project is open source and available under the MIT License.

## 🙏 Acknowledgments

- **Hugging Face** for Transformers.js and hosting models
- **Facebook AI** for the NLLB-200 translation model
- **SheetJS** for excellent Excel handling
- **Mammoth.js** for Word document processing

## 📚 Based On

This project was inspired by translation workflows from [mijnidbcoachnlp](https://github.com/putssander/mijnidbcoachnlp), specifically the translation notebook that used CTranslate2. This browser-based version makes the same functionality accessible without any installation.

## 🌟 Features Roadmap

- [ ] Support for more file formats (CSV, PDF)
- [ ] Batch file processing
- [ ] Translation memory/glossary support
- [ ] Custom model selection
- [ ] Dark mode
- [ ] Offline PWA support
- [ ] Better Word formatting preservation

## ❓ FAQ

**Q: Do I need to install anything?**  
A: No! Just open `index.html` in a modern browser.

**Q: Can I use this offline?**  
A: After the first use (when the model is downloaded and cached), yes!

**Q: How much does it cost?**  
A: It's completely free. No API keys, no subscriptions.

**Q: Is my data safe?**  
A: Absolutely. Everything runs locally in your browser. No data leaves your device.

**Q: Which browsers are supported?**  
A: Modern versions of Chrome, Firefox, Edge, and Safari (with WebAssembly support).

**Q: Can I translate between any two languages?**  
A: Yes! The NLLB-200 model supports 200+ languages. You can add more to the dropdowns.

**Q: Why is the first translation slow?**  
A: The model needs to be downloaded first (~300MB). After that, it's cached and translations are fast.

---

**Made with ❤️ using Transformers.js**

Happy translating! 🌍
