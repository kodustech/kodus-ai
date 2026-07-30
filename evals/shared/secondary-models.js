// Shared model registry for secondary-pass evals (dedup / severity / format).
// Same candidates we need to certify before routing secondary work through client BYOK.
//
// Keys mirror the benchmark / tier0 secrets so CI can reuse one secret set.

const SECONDARY_MODELS = {
    'gpt-5.4-mini': {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'],
    },
    'gemini-3-flash-preview': {
        provider: 'google',
        model: 'gemini-3-flash-preview',
        keyEnv: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'],
    },
    'gemini-2.5-flash': {
        provider: 'google',
        model: 'gemini-2.5-flash',
        keyEnv: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'],
    },
    'kimi-k2.7-code': {
        provider: 'openai-compatible',
        model: 'kimi-k2.7-code',
        baseURL: 'https://api.moonshot.ai/v1',
        keyEnv: ['BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'],
    },
    'glm-5.2': {
        provider: 'openai-compatible',
        model: 'glm-5.2',
        baseURL: 'https://api.z.ai/api/paas/v4',
        keyEnv: ['BYOK_ZHIPU_API_KEY', 'API_ZHIPU_API_KEY'],
    },
    'haiku-4.5': {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        keyEnv: [
            'ANTHROPIC_API_KEY',
            'BYOK_ANTHROPIC_API_KEY',
            'API_ANTHROPIC_API_KEY',
        ],
    },
};

/** Production secondary-pass baseline. */
const SECONDARY_BASELINE = 'gpt-5.4-mini';

/** Default A/B matrix (cheap + common BYOK picks). */
const SECONDARY_MATRIX = [
    'gpt-5.4-mini',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'kimi-k2.7-code',
    'glm-5.2',
];

function resolveKey(keyEnvs, env = process.env) {
    for (const e of keyEnvs) {
        if (env[e]) return env[e];
    }
    return null;
}

async function buildSecondaryModel(modelKey, env = process.env) {
    const spec = SECONDARY_MODELS[modelKey];
    if (!spec) {
        throw new Error(
            `unknown secondary model '${modelKey}' (have: ${Object.keys(SECONDARY_MODELS).join(', ')})`,
        );
    }
    const apiKey = resolveKey(spec.keyEnv, env);
    if (!apiKey) {
        throw new Error(`no key for ${modelKey} (${spec.keyEnv.join('/')})`);
    }

    if (spec.provider === 'google') {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey })(spec.model);
    }
    if (spec.provider === 'anthropic') {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey })(spec.model);
    }
    if (spec.provider === 'openai') {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey })(spec.model);
    }
    if (spec.provider === 'openai-compatible') {
        const { createOpenAICompatible } = await import(
            '@ai-sdk/openai-compatible'
        );
        return createOpenAICompatible({
            name: 'secondary-eval',
            apiKey,
            baseURL: spec.baseURL,
        })(spec.model);
    }
    throw new Error(`unsupported provider ${spec.provider}`);
}

module.exports = {
    SECONDARY_MODELS,
    SECONDARY_BASELINE,
    SECONDARY_MATRIX,
    resolveKey,
    buildSecondaryModel,
};
