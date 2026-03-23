const LEGACY_TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

export const TRANSLATION_MODEL = 'Xenova/nllb-200-distilled-600M';
export const TRANSLATION_RUNTIME_LABEL = 'Xenova Transformers.js v2';

let runtimeModulePromise = null;
let translator = null;
let initPromise = null;

async function loadLegacyRuntime() {
    if (runtimeModulePromise) return runtimeModulePromise;

    runtimeModulePromise = (async () => {
        const runtime = await import(LEGACY_TRANSFORMERS_URL);
        const { env } = runtime;

        env.allowLocalModels = false;
        env.useBrowserCache = true;

        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.numThreads = 1;
        }

        return runtime;
    })();

    return runtimeModulePromise;
}

export function getTranslationPipeline() {
    return translator;
}

export async function initTranslationPipeline({ progressCallback } = {}) {
    if (translator) return translator;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const { pipeline } = await loadLegacyRuntime();
        translator = await pipeline('translation', TRANSLATION_MODEL, {
            quantized: true,
            progress_callback: progressCallback,
        });
        return translator;
    })();

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

export async function preloadTranslationModel({ progressCallback } = {}) {
    if (translator) return;

    const { pipeline } = await loadLegacyRuntime();
    const tempPipeline = await pipeline('translation', TRANSLATION_MODEL, {
        quantized: true,
        progress_callback: progressCallback,
    });

    if (tempPipeline && typeof tempPipeline.dispose === 'function') {
        await tempPipeline.dispose();
    }
}

export async function disposeTranslationPipeline() {
    if (!translator) return;

    try {
        if (typeof translator.dispose === 'function') {
            await translator.dispose();
        }
    } finally {
        translator = null;
        initPromise = null;
    }
}