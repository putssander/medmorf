const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.js';
const ORT_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';

export const PRIVACY_RUNTIME_LABEL = 'Hugging Face Transformers.js v3';
export const DEFAULT_NER_MODEL_ID = 'multilang_pii';

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
};

let transformersModulePromise = null;
let nerPipeline = null;
let activeNerModelId = null;
let activeNerDtype = null;
let nerInitPromise = null;

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
    return nerPipeline;
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
    let lastError = null;

    for (const dtype of dtypes) {
        try {
            const instance = await pipeline('token-classification', option.model, {
                dtype,
                progress_callback: progressCallback,
            });
            activeNerDtype = dtype;
            console.log(`[NER] Loaded ${option.label} with dtype ${dtype}`);
            return instance;
        } catch (error) {
            lastError = error;
            console.warn(`[NER] Failed to load ${option.label} with dtype ${dtype}`, error);
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
        if (nerPipeline && activeNerModelId !== option.id) {
            await disposeNERPipeline();
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
    activeNerModelId = null;
    activeNerDtype = null;
    nerInitPromise = null;

    if (pipelineToDispose && typeof pipelineToDispose.dispose === 'function') {
        await pipelineToDispose.dispose();
    }
}