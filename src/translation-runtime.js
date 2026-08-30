const LEGACY_TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

import { preflightWarn, withHeavyLoadLock } from './pre-flight-warn.js?v=2026-08-30-memory-bar-2';
import { registerLoadedModel, unregisterLoadedModel, markModelUsed } from './lifecycle-manager.js?v=2026-05-21-stability-1';

export const TRANSLATION_MODEL = 'Xenova/nllb-200-distilled-600M';
export const TRANSLATION_MODEL_SIZE_MB = 600;
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

export async function initTranslationPipeline({ progressCallback, skipPreflight } = {}) {
    if (translator) return translator;
    if (initPromise) return initPromise;

    if (!skipPreflight) {
        const proceed = await preflightWarn({
            key: `translation:${TRANSLATION_MODEL}`,
            title: 'Load translation model?',
            model: `NLLB-200 distilled 600M (${TRANSLATION_MODEL})`,
            sizeMB: TRANSLATION_MODEL_SIZE_MB,
            why: 'Multilingual translation model. Runs locally on CPU (WASM). On mobile or low-RAM devices the load can take a long time.',
        });
        if (!proceed) {
            throw new Error('Translation model load cancelled by user');
        }
    }

    initPromise = withHeavyLoadLock('Translation: NLLB-200 600M', async () => {
        const { pipeline } = await loadLegacyRuntime();
        translator = await pipeline('translation', TRANSLATION_MODEL, {
            quantized: true,
            progress_callback: progressCallback,
        });
        registerLoadedModel('translation', disposeTranslationPipeline, { sizeMB: TRANSLATION_MODEL_SIZE_MB });
        return translator;
    });

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

export async function preloadTranslationModel({ progressCallback } = {}) {
    if (translator) return;

    const proceed = await preflightWarn({
        key: `translation:${TRANSLATION_MODEL}`,
        title: 'Pre-download translation model?',
        model: `NLLB-200 distilled 600M (${TRANSLATION_MODEL})`,
        sizeMB: TRANSLATION_MODEL_SIZE_MB,
        why: 'Pre-caches the translation model so it works offline next time.',
    });
    if (!proceed) {
        throw new Error('Translation preload cancelled by user');
    }

    return withHeavyLoadLock('Translation preload: NLLB-200 600M', async () => {
        const { pipeline } = await loadLegacyRuntime();
        const tempPipeline = await pipeline('translation', TRANSLATION_MODEL, {
            quantized: true,
            progress_callback: progressCallback,
        });

        if (tempPipeline && typeof tempPipeline.dispose === 'function') {
            await tempPipeline.dispose();
        }
    });
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
        unregisterLoadedModel('translation');
    }
}
