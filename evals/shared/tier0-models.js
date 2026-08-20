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
    'gemini-3.1-flash-lite': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    // NOTA: as chaves novas do AI Studio (prefixo `AQ.`, "auth keys") levam 401
    // ACCESS_TOKEN_TYPE_UNSUPPORTED quando a conexao e HTTP/2 — bug do edge da
    // Google. O fetch do Node negocia HTTP/1.1, entao este caminho funciona;
    // reproduzir com curl exige --http1.1.
    'gemini-3.7-flash': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] , 
    'kimi-k2.7-code': { provider: 'openai_compatible', keyEnvs: ['BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'], baseURL: 'https://api.moonshot.ai/v1' },
    'glm-5.2': { provider: 'openai_compatible', keyEnvs: ['BYOK_ZHIPU_API_KEY', 'API_ZHIPU_API_KEY'], baseURL: 'https://api.z.ai/api/paas/v4' },
    // V4-Pro saiu de preview em 2026-08 (build 0813). Mesmo endpoint do flash.
    'deepseek-v4-pro': { provider: 'openai_compatible', keyEnvs: ['BYOK_DEEPSEEK_API_KEY', 'API_DEEPSEEK_API_KEY'], baseURL: 'https://api.deepseek.com' },
    'deepseek-v4-flash': { provider: 'openai_compatible', keyEnvs: ['BYOK_DEEPSEEK_API_KEY', 'API_DEEPSEEK_API_KEY'], baseURL: 'https://api.deepseek.com/v1' },
    // K3 usa chave própria (KIMI_NEW) — crédito limitado, ver custo antes de
    // disparar passada cheia: $3/$15 por milhão, ~3x o k2.7.
    'kimi-k3': { provider: 'openai_compatible', keyEnvs: ['KIMI_NEW', 'BYOK_MOONSHOT_API_KEY'], baseURL: 'https://api.moonshot.ai/v1' },

    // NVIDIA NIM (integrate.api.nvidia.com) — gateway OpenAI-compatible. Usado
    // quando a API nativa do fornecedor está indisponível (Z.ai sem saldo,
    // MiniMax sem chave). Modelo servido por intermediário: registrar como
    // provider `nvidia`, não como se fosse a API nativa.
    'minimax-m3@nvidia': { provider: 'openai_compatible', doModel: 'minimaxai/minimax-m3', keyEnvs: ['NVIDIA_API_KEY'], baseURL: 'https://integrate.api.nvidia.com/v1' },
    'glm-5.2@nvidia': { provider: 'openai_compatible', doModel: 'z-ai/glm-5.2', keyEnvs: ['NVIDIA_API_KEY'], baseURL: 'https://integrate.api.nvidia.com/v1' },

    // Meta Model API (api.meta.ai) — OpenAI-compatible, rota nativa.
    // Standard tier: $1,25 in / $4,25 out. O tier `-contributor` (12x mais
    // barato) nao esta provisionado nesta conta.
    'muse-spark-1.2': { provider: 'openai_compatible', keyEnvs: ['META_MUSE_API_KEY'], baseURL: 'https://api.meta.ai/v1' },

    // xAI — OpenAI-compatible. ATENCAO no custo: o preco DOBRA acima de 200k
    // tokens de prompt, e os casos do light 30 passam disso com folga (media
    // ~500k). Orcar pelo dobro da tabela, nao pela tabela.
    'grok-4.5': { provider: 'openai_compatible', keyEnvs: ['X_AI_KEY', 'BYOK_XAI_API_KEY'], baseURL: 'https://api.x.ai/v1' },
    // Alibaba DashScope (endpoint internacional, modo OpenAI-compatible).
    'qwen3.8-max': { provider: 'openai_compatible', keyEnvs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'], baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    // Rota Akash — catalogo confirmado por inferencia real (finish_reason: stop).
    'qwen3.8-27b': { provider: 'openai_compatible', doModel: 'Qwen/Qwen3.8-27B', keyEnvs: ['AKASH_ML'], baseURL: 'https://api.akashml.com/v1' },

    // Rota de ASSINATURA (Codex OAuth): credencial vem de ~/.codex/auth.json,
    // nao de env. Cobra na cota semanal do plano ChatGPT, nao por token — sai
    // no leaderboard com accessPath=subscription e SEM coluna de custo.
    'gpt-5.6-sol@sub': { provider: 'codex_subscription', codexModel: 'gpt-5.6-sol', keyEnvs: [] },
    'gpt-5.6-luna@sub': { provider: 'codex_subscription', codexModel: 'gpt-5.6-luna', keyEnvs: [] },
    'gpt-5.6-terra@sub': { provider: 'codex_subscription', codexModel: 'gpt-5.6-terra', keyEnvs: [] },
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
    // Assinatura nao usa env var: credencial em ~/.codex/auth.json, modelo
    // construido direto em createModel (agent-provider.js).
    if (spec.provider === 'codex_subscription') return spec;
    const key = spec.keyEnvs.map((e) => env[e]).find(Boolean);
    if (!key) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/')}`);

    // id do TIER0 pode ter sufixo de roteamento (@nvidia, @do); o provider
    // recebe o id real do modelo.
    env.API_LLM_PROVIDER_MODEL = spec.doModel || modelId;
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
