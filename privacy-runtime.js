const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js';
const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/';
// Externalize @xenova/transformers so the browser import map resolves it to v3.
// gliner@0.0.19 depends on @xenova/transformers@2.17.2 whose BPE tokenizer
// cannot handle ModernBERT's byte-level tokenizer format (causes t.split error).
// v3's AutoTokenizer handles it correctly.
const GLINER_URL = 'https://esm.sh/gliner@0.0.19?external=@xenova/transformers';

export const PRIVACY_RUNTIME_LABEL = 'Hugging Face Transformers.js v3';
export const DEFAULT_NER_MODEL_ID = 'gliner_pii';

export const NER_MODEL_OPTIONS = {
    multilang_pii: {
        id: 'multilang_pii',
        label: 'Multilingual PII NER (XLM-RoBERTa)',
        model: 'onnx-community/multilang-pii-ner-ONNX',
        description: 'XLM-RoBERTa fine-tuned on PII data. Strong on names, addresses, dates, phone numbers.',
        supportedLanguages: ['Dutch', 'English', 'French', 'German'],
        qualityNote: 'Best balance of PII detection quality, speed and multilingual support.',
        categoriesLabel: 'PERSON, EMAIL, PHONE, ADDRESS, ID_NUMBER, DATE, LOCATION, AGE, OTHER',
        cacheMatchers: ['multilang-pii-ner'],
        dtypes: ['q8', 'fp32'],
        typeMap: {
            GIVENNAME: 'PERSON',
            SURNAME: 'PERSON',
            EMAIL: 'EMAIL',
            TELEPHONENUM: 'PHONE',
            DATE: 'DATE',
            TIME: 'DATE',
            CITY: 'LOCATION',
            STREET: 'ADDRESS',
            BUILDINGNUM: 'ADDRESS',
            ZIPCODE: 'ADDRESS',
            AGE: 'AGE',
            SEX: 'OTHER',
            GENDER: 'OTHER',
            TITLE: 'OTHER',
            SOCIALNUM: 'ID_NUMBER',
            IDCARDNUM: 'ID_NUMBER',
            PASSPORTNUM: 'ID_NUMBER',
            DRIVERLICENSENUM: 'ID_NUMBER',
            CREDITCARDNUMBER: 'ID_NUMBER',
            TAXNUM: 'ID_NUMBER',
            ACCOUNTNUM: 'ID_NUMBER',
        },
    },
    gliner_pii: {
        id: 'gliner_pii',
        engine: 'gliner',
        label: 'GLiNER PII Edge (ModernBERT)',
        model: 'knowledgator/gliner-pii-edge-v1.0',
        onnxModelPath: 'https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model_quint8.onnx',
        description: 'Zero-shot PII detection. Specify entity types at runtime — no retraining needed.',
        supportedLanguages: ['English', 'Multilingual (zero-shot)'],
        qualityNote: 'Lightweight edge model (32M params). Very fast, ~46 MB download. Best for English PII.',
        categoriesLabel: 'PERSON, EMAIL, PHONE, ADDRESS, ID_NUMBER, DATE, LOCATION, ORGANIZATION',
        cacheMatchers: ['gliner-pii-edge'],
        piiLabels: [
            'name', 'first name', 'last name', 'name medical professional',
            'dob', 'age',
            'email address', 'phone number',
            'location address', 'location street', 'location city',
            'location state', 'location country', 'location zip',
            'ssn', 'healthcare number', 'passport number', 'driver license',
            'account number', 'bank account', 'credit card',
            'organization medical facility', 'username',
        ],
        threshold: 0.3,
        typeMap: {
            'name': 'PERSON', 'first name': 'PERSON', 'last name': 'PERSON',
            'name medical professional': 'PERSON',
            'dob': 'DATE', 'age': 'AGE',
            'email address': 'EMAIL', 'phone number': 'PHONE',
            'location address': 'ADDRESS', 'location street': 'ADDRESS',
            'location city': 'LOCATION', 'location state': 'LOCATION',
            'location country': 'LOCATION', 'location zip': 'ADDRESS',
            'ssn': 'ID_NUMBER', 'healthcare number': 'ID_NUMBER',
            'passport number': 'ID_NUMBER', 'driver license': 'ID_NUMBER',
            'account number': 'ID_NUMBER', 'bank account': 'ID_NUMBER',
            'credit card': 'ID_NUMBER',
            'organization medical facility': 'ORGANIZATION',
            'username': 'ID_NUMBER',
        },
    },
    multilingual_ner: {
        id: 'multilingual_ner',
        label: 'Multilingual BERT NER',
        model: 'Xenova/bert-base-multilingual-cased-ner-hrl',
        description: 'Lighter multilingual NER focused on people, places and organizations.',
        supportedLanguages: ['Multilingual high-resource language set'],
        qualityNote: 'General-purpose NER, not specialized for medical privacy categories.',
        categoriesLabel: 'PERSON, LOCATION, ORGANIZATION, OTHER',
        cacheMatchers: ['bert-base-multilingual-cased-ner-hrl'],
        dtypes: ['q8', 'fp32'],
        typeMap: {
            PER: 'PERSON',
            PERSON: 'PERSON',
            LOC: 'LOCATION',
            LOCATION: 'LOCATION',
            ORG: 'ORGANIZATION',
            ORGANIZATION: 'ORGANIZATION',
            MISC: 'OTHER',
        },
    },
    openai_privacy_filter: {
        id: 'openai_privacy_filter',
        label: 'OpenAI Privacy Filter (1.5B, WebGPU)',
        model: 'openai/privacy-filter',
        description: 'OpenAI bidirectional token classifier for PII detection (8 span categories incl. names, emails, addresses, dates, URLs, account numbers, secrets).',
        supportedLanguages: ['English (primary)', 'Multilingual robustness reported'],
        qualityNote: '~1.5B params, q4 quantized. Runs in-browser via WebGPU; falls back to WASM if WebGPU is unavailable (slower).',
        categoriesLabel: 'PERSON, EMAIL, PHONE, ADDRESS, DATE, URL, ID_NUMBER, OTHER',
        cacheMatchers: ['privacy-filter'],
        dtypes: ['q4', 'q8'],
        device: 'webgpu',
        deviceFallback: true,
        typeMap: {
            private_person: 'PERSON',
            private_email: 'EMAIL',
            private_phone: 'PHONE',
            private_address: 'ADDRESS',
            private_date: 'DATE',
            private_url: 'OTHER',
            account_number: 'ID_NUMBER',
            secret: 'ID_NUMBER',
        },
    },
};

let transformersModulePromise = null;
let nerPipeline = null;
let activeNerModelId = null;
let activeNerDtype = null;
let nerInitPromise = null;

// GLiNER state
let glinerModulePromise = null;
let glinerInstance = null;

async function loadTransformersModule() {
    if (!transformersModulePromise) {
        transformersModulePromise = import(TRANSFORMERS_URL);
    }
    return transformersModulePromise;
}

function configureEnv(env) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = ORT_WASM_PATH;
        if (typeof env.backends.onnx.wasm.numThreads === 'number') {
            env.backends.onnx.wasm.numThreads = 1;
        }
    }
}

export function getNERModelOption(modelId = DEFAULT_NER_MODEL_ID) {
    return NER_MODEL_OPTIONS[modelId] || NER_MODEL_OPTIONS[DEFAULT_NER_MODEL_ID];
}

export function getActiveNERModelOption() {
    return getNERModelOption(activeNerModelId || DEFAULT_NER_MODEL_ID);
}

export function getNERPipeline() {
    return nerPipeline || glinerInstance;
}

export function isGLiNERModel(modelId) {
    const option = getNERModelOption(modelId || activeNerModelId || DEFAULT_NER_MODEL_ID);
    return option.engine === 'gliner';
}

export function getGLiNERInstance() {
    return glinerInstance;
}

export function getActiveNERModelId() {
    return activeNerModelId || DEFAULT_NER_MODEL_ID;
}

export function getActiveNERLoadLabel() {
    if (!activeNerDtype) {
        return null;
    }
    return activeNerDtype;
}

export function mapNEREntityType(rawType, modelId = activeNerModelId || DEFAULT_NER_MODEL_ID) {
    const option = getNERModelOption(modelId);
    return option.typeMap[rawType] || rawType;
}

async function createNERPipelineWithFallback(pipeline, option, progressCallback) {
    const dtypes = Array.isArray(option.dtypes) && option.dtypes.length ? option.dtypes : ['q8'];
    const devices = option.device
        ? (option.deviceFallback ? [option.device, undefined] : [option.device])
        : [undefined];
    let lastError = null;

    for (const device of devices) {
        for (const dtype of dtypes) {
            try {
                const opts = {
                    dtype,
                    progress_callback: progressCallback,
                };
                if (device) opts.device = device;
                const instance = await pipeline('token-classification', option.model, opts);
                activeNerDtype = device ? `${dtype} (${device})` : dtype;
                console.log(`[NER] Loaded ${option.label} with dtype ${dtype}${device ? ' on ' + device : ''}`);
                return instance;
            } catch (error) {
                lastError = error;
                console.warn(`[NER] Failed to load ${option.label} with dtype ${dtype}${device ? ' on ' + device : ''}`, error);
            }
        }
    }

    throw lastError || new Error(`Failed to load ${option.label}`);
}

export async function initNERPipeline({ modelId = DEFAULT_NER_MODEL_ID, progressCallback } = {}) {
    const option = getNERModelOption(modelId);
    if (nerPipeline && activeNerModelId === option.id) {
        return nerPipeline;
    }
    if (nerInitPromise) {
        return nerInitPromise;
    }

    nerInitPromise = (async () => {
        if ((nerPipeline || glinerInstance) && activeNerModelId !== option.id) {
            await disposeNERPipeline();
        }

        if (option.engine === 'gliner') {
            glinerInstance = await initGLiNERInstance(option, progressCallback);
            activeNerModelId = option.id;
            activeNerDtype = 'quint8';
            return glinerInstance;
        }

        const { pipeline, env } = await loadTransformersModule();
        configureEnv(env);

        nerPipeline = await createNERPipelineWithFallback(pipeline, option, progressCallback);
        activeNerModelId = option.id;
        return nerPipeline;
    })();

    try {
        return await nerInitPromise;
    } finally {
        nerInitPromise = null;
    }
}

export async function preloadNERModel({ modelId = DEFAULT_NER_MODEL_ID, progressCallback } = {}) {
    const option = getNERModelOption(modelId);
    const { pipeline, env } = await loadTransformersModule();
    configureEnv(env);

    const tempPipeline = await createNERPipelineWithFallback(pipeline, option, progressCallback);

    if (tempPipeline && typeof tempPipeline.dispose === 'function') {
        await tempPipeline.dispose();
    }

    activeNerDtype = null;
}

export async function disposeNERPipeline() {
    const pipelineToDispose = nerPipeline;
    nerPipeline = null;
    glinerInstance = null;
    activeNerModelId = null;
    activeNerDtype = null;
    nerInitPromise = null;

    if (pipelineToDispose && typeof pipelineToDispose.dispose === 'function') {
        await pipelineToDispose.dispose();
    }
}

// ── GLiNER Loading ─────────────────────────────────────────────────────────────
async function loadGLiNERModule() {
    if (!glinerModulePromise) {
        glinerModulePromise = import(GLINER_URL);
    }
    return glinerModulePromise;
}

async function initGLiNERInstance(option, progressCallback) {
    if (progressCallback) {
        progressCallback({ status: 'progress', loaded: 0, total: 100 });
    }

    const { Gliner } = await loadGLiNERModule();
    console.log('[GLiNER] Module loaded, initializing model...');

    if (progressCallback) {
        progressCallback({ status: 'progress', loaded: 30, total: 100 });
    }

    const instance = new Gliner({
        tokenizerPath: option.model,
        onnxSettings: {
            modelPath: option.onnxModelPath,
            executionProvider: 'cpu',
        },
        // Keep env.useBrowserCache=true since GLiNER now shares the v3 env
        // object with our NER pipeline (via import map alias).
        transformersSettings: {
            allowLocalModels: false,
            useBrowserCache: true,
        },
        maxWidth: 12,
        modelType: 'token-level',
    });

    await instance.initialize();

    // Fix 1: gliner@0.0.19 hardcodes CLS token ID = 1 (correct for DeBERTa-v3,
    // wrong for ModernBERT where CLS = 50281). Monkey-patch the processor's
    // encodeInputs to replace the hardcoded 1 with the actual CLS token ID.
    const processor = instance.model?.processor;
    if (processor && processor.tokenizer) {
        const tokenizer = processor.tokenizer;
        let clsId = tokenizer.cls_token_id;
        if (clsId === undefined || clsId === null) {
            try {
                const probe = tokenizer.encode('a');
                clsId = probe?.[0];
            } catch (e) {
                console.warn('[GLiNER] Could not probe CLS token:', e);
            }
        }
        if (clsId !== undefined && clsId !== null && clsId !== 1) {
            const origEncodeInputs = processor.encodeInputs.bind(processor);
            processor.encodeInputs = function (texts, promptLengths) {
                const [inputsIds, attentionMasks, wordsMasks] = origEncodeInputs(texts, promptLengths);
                for (const ids of inputsIds) {
                    if (ids[0] === 1) ids[0] = clsId;
                }
                return [inputsIds, attentionMasks, wordsMasks];
            };
            console.log(`[GLiNER] Patched CLS token: 1 → ${clsId}`);
        }
    }

    // Fix 2: gliner@0.0.19's TokenDecoder reads logits as flat array indexed
    // [position][batch][token][entity] (i.e. position-major order). But the
    // ONNX model for gliner-pii-edge outputs [batch, words, entities, 3] where
    // 3 = start/end/inside (position as the LAST axis). Without transposing,
    // the decoder misreads all probabilities and finds zero entities.
    const onnxWrapper = instance.model?.onnxWrapper;
    if (onnxWrapper) {
        const origRun = onnxWrapper.run.bind(onnxWrapper);
        onnxWrapper.run = async function (feeds, options) {
            const result = await origRun(feeds, options);
            const logits = result.logits;
            if (logits && logits.dims && logits.dims.length === 4) {
                const [d0, d1, d2, d3] = logits.dims;
                // Detect [batch, words, entities, 3] layout — d3 === 3 means
                // position is last (ONNX model layout), not first (JS expected).
                if (d3 === 3 && d0 !== 3) {
                    // Transpose to [3, batch, words, entities]
                    const data = logits.data;
                    const transposed = new Float32Array(data.length);
                    for (let b = 0; b < d0; b++) {
                        for (let w = 0; w < d1; w++) {
                            for (let e = 0; e < d2; e++) {
                                for (let p = 0; p < 3; p++) {
                                    const srcIdx = ((b * d1 + w) * d2 + e) * 3 + p;
                                    const dstIdx = ((p * d0 + b) * d1 + w) * d2 + e;
                                    transposed[dstIdx] = data[srcIdx];
                                }
                            }
                        }
                    }
                    const Tensor = onnxWrapper.ort.Tensor;
                    result.logits = new Tensor('float32', transposed, [3, d0, d1, d2]);
                    console.log(`[GLiNER] Transposed logits: [${d0},${d1},${d2},${d3}] → [3,${d0},${d1},${d2}]`);
                }
            }
            return result;
        };
        console.log('[GLiNER] Patched ONNX logits transpose');
    }

    console.log(`[GLiNER] ${option.label} initialized`);

    if (progressCallback) {
        progressCallback({ status: 'progress', loaded: 100, total: 100 });
    }

    return instance;
}