// Shared tier-0 model seam for the replay evals (kody-rules, anchoring, …).
//
// Maps each tier-0 (curated-models.json tier="recommended") model id to the env
// the production `byokToVercelModel` self-hosted path reads, so a single
// `--model=<id>` runs through the SAME provider routing the engine uses in prod
// (and the benchmark uses on QA). No per-eval provider code.
//
// Routing recap (byokToVercelModel, no BYOK config → self-hosted path):
//   API_LLM_PROVIDER_MODEL = <id>   picks the model + provider by name prefix
//   gemini-*  → Google AI Studio   key in API_GOOGLE_AI_API_KEY
//   claude-*  → Anthropic native   key in API_OPEN_AI_API_KEY (no force base url)
//   anything  → OpenAI-compatible  key in API_OPEN_AI_API_KEY (+ API_OPENAI_FORCE_BASE_URL)

// id → { provider, keyEnvs (first present wins), baseURL? }
// keyEnvs mirror the benchmark's secret names so the same CI secrets work.
const TIER0 = {
    'gpt-5.4': { provider: 'openai', keyEnvs: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-5.4-mini': { provider: 'openai', keyEnvs: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'claude-sonnet-4-6': { provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'claude-opus-4-7': { provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'gemini-3.1-pro-preview-customtools': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    'gemini-3-flash-preview': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    'kimi-k2.7-code': { provider: 'openai_compatible', keyEnvs: ['BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'], baseURL: 'https://api.moonshot.ai/v1' },
    'glm-5.2': { provider: 'openai_compatible', keyEnvs: ['BYOK_ZHIPU_API_KEY', 'API_ZHIPU_API_KEY'], baseURL: 'https://api.z.ai/api/paas/v4' },
};

// Models the benchmark excludes from the default full run (cost). Opt in with
// --model to force one.
const EXCLUDED_BY_DEFAULT = new Set(['claude-opus-4-7']);

// Default matrix = recommended tier-0 minus the excluded ones.
function defaultMatrix() {
    return Object.keys(TIER0).filter((id) => id !== 'gpt-5.4-mini' && !EXCLUDED_BY_DEFAULT.has(id));
}

// Point the env at `modelId` so byokToVercelModel(null,'main') builds it.
// Returns the spec; throws a clear error when the model is unknown or its key is
// absent (so a CI matrix leg fails loudly instead of silently picking a default).
function applyModelEnv(modelId, env = process.env) {
    const spec = TIER0[modelId];
    if (!spec) throw new Error(`unknown tier-0 model '${modelId}' (known: ${Object.keys(TIER0).join(', ')})`);
    const key = spec.keyEnvs.map((e) => env[e]).find(Boolean);
    if (!key) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/')}`);

    env.API_LLM_PROVIDER_MODEL = modelId;
    // Clear any base-url left from a prior model so anthropic/google don't get
    // mis-proxied (one process = one model in CI, but stay defensive).
    delete env.API_OPENAI_FORCE_BASE_URL;

    if (spec.provider === 'google') {
        env.API_GOOGLE_AI_API_KEY = key;
    } else {
        // openai + anthropic-native + openai-compatible all read API_OPEN_AI_API_KEY.
        env.API_OPEN_AI_API_KEY = key;
        if (spec.baseURL) env.API_OPENAI_FORCE_BASE_URL = spec.baseURL;
    }
    return spec;
}

// Flags for the promptfoo evals (investigation, promotion) that accept explicit
// --provider/--model/--base-url/--api-key-env — lets them run the SAME tier-0
// model without depending on their own (stale) preset registries. The key is
// read from the env var applyModelEnv populated.
const PROMPTFOO_PROVIDER = {
    openai: 'openai', anthropic: 'anthropic', google: 'google', openai_compatible: 'openai-compatible',
};
function promptfooFlags(modelId) {
    const spec = TIER0[modelId];
    if (!spec) throw new Error(`unknown tier-0 model '${modelId}'`);
    const apiKeyEnv = spec.provider === 'google' ? 'API_GOOGLE_AI_API_KEY' : 'API_OPEN_AI_API_KEY';
    return [
        '--provider', PROMPTFOO_PROVIDER[spec.provider],
        '--model', modelId,
        '--api-key-env', apiKeyEnv,
        ...(spec.baseURL ? ['--base-url', spec.baseURL] : []),
    ];
}

module.exports = { TIER0, EXCLUDED_BY_DEFAULT, defaultMatrix, applyModelEnv, promptfooFlags };
