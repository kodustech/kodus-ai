// Shared model-routing seam for the replay evals (kody-rules, anchoring, …).
//
// Maps a model id to the env the production `buildModelFromSlot` self-hosted
// path reads, so a single `--model=<id>` runs through the SAME provider routing
// the engine uses in prod (and the benchmark uses on QA). No per-eval provider
// code.
//
// TWO lists live here and they are NOT the same thing:
//
//   TIER0     every id an eval can pin with `--model=`. A routing table, not a
//             recommendation — the `@nvidia` / `@novita` / `@sub` routes and
//             the Akash one are experiment paths nobody ships.
//   tier0()   the models the push-to-main suite gates on, marked `tier0: true`
//             below. THIS is the list the CI matrix reads.
//
// The header here used to say tier-0 meant `curated-models.json` with
// tier="recommended". That file was deleted in 99c6171a8, when the BYOK catalog
// moved to the backend, and the `CatalogModel` that replaced it carries no tier
// field — so the product has no recommended set to derive from today. Until it
// does, tier-0 is declared here, once, instead of copy-pasted into a workflow
// where it drifted unnoticed.
//
// An eval reaches these models the way a cloud org does (evals/shared/
// model-route.js): through a stored BYOK config holding its key from `keyEnvs`.
// `kodus-managed` alone has no stored config: an org with no model of its own.

// id → { provider, keyEnvs (first present wins), baseURL? }
// keyEnvs mirror the benchmark's secret names so the same CI secrets work.
const TIER0 = {
    'gpt-5.4': { provider: 'openai', keyEnvs: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-5.4-mini': { provider: 'openai', keyEnvs: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-6-sol': { tier0: true, provider: 'openai', keyEnvs: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'claude-sonnet-4-6': { provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'claude-sonnet-5-5': { tier0: true, provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'claude-opus-4-7': { provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'claude-opus-5-5': { provider: 'anthropic', keyEnvs: ['API_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'gemini-3.1-pro-preview-customtools': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    'gemini-3-flash-preview': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    // NOTA: as chaves novas do AI Studio (prefixo `AQ.`, "auth keys") levam 401
    // ACCESS_TOKEN_TYPE_UNSUPPORTED quando a conexao e HTTP/2 — bug do edge da
    // Google. O fetch do Node negocia HTTP/1.1, entao este caminho funciona;
    // reproduzir com curl exige --http1.1.
    'gemini-3.7-flash': { provider: 'google', keyEnvs: ['BYOK_GOOGLE_API_KEY', 'API_GOOGLE_AI_API_KEY'] },
    'kimi-k2.7-code': { provider: 'openai_compatible', keyEnvs: ['BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'], baseURL: 'https://api.moonshot.ai/v1' },
    // The tier-0 Kimi, served through OpenRouter: the Moonshot account was
    // suspended for balance (2026-10), and OpenRouter is where the credit is.
    // Same model; the host differs from Moonshot-native.
    'kimi-k2.7-code@openrouter': { tier0: true, provider: 'openai_compatible', doModel: 'moonshotai/kimi-k2.7-code', openrouterProviderOrder: ['moonshotai'], keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    // Production's other review models, through OpenRouter: MiniMax-M3 and
    // GLM-5.3 carry most of the finder's parse losses (#2112), Gemini 3.1 Pro
    // and 3.8 Flash are among the most used. Routes for the evals that record
    // or replay model output (evals/parse); not tier-0.
    'minimax-m3@openrouter': { provider: 'openai_compatible', doModel: 'minimax/minimax-m3', keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    'glm-5.3@openrouter': { provider: 'openai_compatible', doModel: 'z-ai/glm-5.3', keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    'gemini-3.1-pro@openrouter': { provider: 'openai_compatible', doModel: 'google/gemini-3.1-pro-preview-customtools', keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    'gemini-3.8-flash@openrouter': { provider: 'openai_compatible', doModel: 'google/gemini-3.8-flash', keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    'glm-5.2': { provider: 'openai_compatible', keyEnvs: ['BYOK_ZHIPU_API_KEY', 'API_ZHIPU_API_KEY'], baseURL: 'https://api.z.ai/api/paas/v4' },
    // V4-Pro saiu de preview em 2026-08 (build 0813). Mesmo endpoint do flash.
    'deepseek-v4-pro': { provider: 'openai_compatible', keyEnvs: ['BYOK_DEEPSEEK_API_KEY', 'API_DEEPSEEK_API_KEY'], baseURL: 'https://api.deepseek.com' },
    'deepseek-v4-flash': { provider: 'openai_compatible', keyEnvs: ['BYOK_DEEPSEEK_API_KEY', 'API_DEEPSEEK_API_KEY'], baseURL: 'https://api.deepseek.com/v1' },
    // The trial/managed default's model (KODUS_TRIAL_MODEL): DeepSeek served via
    // FIREWORKS, not DeepSeek-native — different transport + build. Measured as an
    // org's BYOK model, like every other; the managed route is `kodus-managed`.
    'deepseek-v4-flash@fireworks': { tier0: true, provider: 'openai_compatible', doModel: 'accounts/fireworks/models/deepseek-v4p1-flash', keyEnvs: ['API_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'BYOK_FIREWORKS_API_KEY'], baseURL: 'https://api.fireworks.ai/inference/v1' },
    // K3 usa chave própria (KIMI_NEW) — crédito limitado, ver custo antes de
    // disparar passada cheia: $3/$15 por milhão, ~3x o k2.7.
    'kimi-k3': { provider: 'openai_compatible', keyEnvs: ['KIMI_NEW', 'BYOK_MOONSHOT_API_KEY'], baseURL: 'https://api.moonshot.ai/v1' },
    // Kimi k2.7-code served via NOVITA (openai_compatible transport) — the host
    // an org may pick instead of Moonshot-native. Different wrapping than the
    // Anthropic-protocol Moonshot endpoint, useful for the return-shape corpus.
    // Fireworks route for the fleet's kimi. The Novita key is AUTH_INVALID and
    // Moonshot direct was unreachable, so this is how the #1826 measurement
    // reaches a real fleet model. Fireworks is on the strict-json_schema
    // allowlist in structured-output-gate.ts, so the shard's wire schema is
    // honored here exactly as in production rather than degrading to
    // json_object — which is what makes the number comparable.
    'kimi-k2.7-code@fireworks': { provider: 'openai_compatible', doModel: 'accounts/fireworks/models/kimi-k2p7-code', keyEnvs: ['API_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY'], baseURL: 'https://api.fireworks.ai/inference/v1' },
    'kimi-k2.7-code@novita': { provider: 'openai_compatible', doModel: 'moonshotai/kimi-k2.7-code', keyEnvs: ['API_NOVITA_AI_API_KEY'], baseURL: 'https://api.novita.ai/v3/openai' },

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
    // GPT-6 and Sonnet 5.5 through the same OpenRouter account as the tier-0
    // Kimi, each pinned to its first-party upstream with fallbacks off. The
    // pin is what a customer's OpenRouter BYOK slot sends
    // (`openrouterProviderOrder`); it applies on the BYOK route
    // (`--byok-reasoning`, which builds an `open_router` slot), not on the env
    // route.
    'gpt-6-sol@openrouter': { provider: 'openai_compatible', doModel: 'openai/gpt-6-sol', openrouterProviderOrder: ['openai'], keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },
    'claude-sonnet-5-5@openrouter': { provider: 'openai_compatible', doModel: 'anthropic/claude-sonnet-5.5', openrouterProviderOrder: ['anthropic'], keyEnvs: ['BYOK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1' },

    // Not a model to pick: what an org with no model config gets, Kodus's default
    // model (libs/llm/byok-defaults.ts KODUS_TRIAL_MODEL) on Kodus's own key, the
    // managed route (libs/llm/managed-slot.ts). Every eval measures the models on
    // BYOK (model-route.js); this one runs only in the managed route's contract
    // test (evals/wiring-smoke.js `managed-route`).
    'kodus-managed': {
        managed: true,
        provider: 'openai_compatible',
        keyEnvs: ['API_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'BYOK_FIREWORKS_API_KEY'],
        baseURL: 'https://api.fireworks.ai/inference/v1',
    },

    // Scripted local model (evals/shared/fake-llm-server.js) for the wiring
    // smoke: an org's BYOK openai_compatible endpoint at 127.0.0.1.
    // Measures nothing — it proves the harness still drives the engine.
    'eval-fake': {
        provider: 'openai_compatible',
        keyEnvs: ['EVAL_FAKE_LLM_KEY'],
        get baseURL() {
            return process.env.EVAL_FAKE_LLM_URL;
        },
    },
    // The same scripted model as an org's Claude slot, so the wiring smoke drives
    // the Claude Agent SDK path (#2113): the CLI talks to the scripted server in
    // the Anthropic Messages format through the gateway.
    'eval-fake-claude': {
        provider: 'anthropic',
        doModel: 'claude-sonnet-5-5',
        keyEnvs: ['EVAL_FAKE_LLM_KEY'],
        get baseURL() {
            return process.env.EVAL_FAKE_LLM_URL;
        },
    },
};

// Models the benchmark excludes from the default full run (cost). Opt in with
// --model to force one.
const EXCLUDED_BY_DEFAULT = new Set(['claude-opus-4-7']);

// Routes that only answer inside the wiring smoke (its local server is up only
// while it runs): never offered as a runnable model.
const LOCAL_ONLY = new Set(['eval-fake', 'eval-fake-claude']);

// The push-to-main gate matrix. Small on purpose: TIER0 is 23 routes and the
// suite cannot run on all of them per merge. Adding a model here costs money on
// every push to main — that is the decision this flag makes explicit.
function tier0() {
    return Object.keys(TIER0).filter((id) => TIER0[id].tier0);
}

// Every routable id minus the ones the benchmark skips by default (cost). NOT
// the gate set — that is tier0(). Read by `run-recall --list-models`.
function defaultMatrix() {
    return Object.keys(TIER0).filter((id) => id !== 'gpt-5.4-mini' && !EXCLUDED_BY_DEFAULT.has(id) && !LOCAL_ONLY.has(id) && !TIER0[id].managed);
}

// The self-hosted env route: points the env at `modelId` so
// buildModelFromSlot(undefined, ...) builds it. Not for an eval, which reaches
// its model the way a cloud org does (evals/shared/model-route.js, rule 5 of
// evals/README.md); kept for scripts/analysis. It writes the model's key over
// API_OPEN_AI_API_KEY, the platform key the dedup's embedder reads.
// Returns the spec; throws a clear error when the model is unknown or its key is
// absent (so a CI matrix leg fails loudly instead of silently picking a default).
function applyModelEnv(modelId, env = process.env) {
    const spec = TIER0[modelId];
    if (!spec) throw new Error(`unknown tier-0 model '${modelId}' (known: ${Object.keys(TIER0).join(', ')})`);
    // A subscription takes no env var: its credential is ~/.codex/auth.json
    // (libs/llm/codex-subscription-model.ts).
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

// The cloud platform's own keys, under the variables production reads them
// from, for an eval that runs the review the way a cloud org gets it: the
// OpenAI key the platform embedder uses (buildPlatformEmbedder: the dedup's
// semantic tier), and the Fireworks key of the managed default model
// (resolveManagedSlot). No org's model is configured here: the cloud has no
// self-hosted env model (API_LLM_PROVIDER_MODEL), so a model either comes from
// the org's stored BYOK config or, with none (`kodus-managed`), is the managed default.
const PLATFORM_KEYS = {
    API_OPEN_AI_API_KEY: ['API_OPEN_AI_API_KEY', 'BYOK_OPENAI_API_KEY'],
    API_FIREWORKS_API_KEY: ['API_FIREWORKS_API_KEY', 'FIREWORKS_API_KEY', 'BYOK_FIREWORKS_API_KEY'],
};
function applyPlatformEnv(env = process.env) {
    delete env.API_LLM_PROVIDER_MODEL;
    delete env.API_OPENAI_FORCE_BASE_URL;
    for (const [name, sources] of Object.entries(PLATFORM_KEYS)) {
        const key = sources.map((e) => env[e]).find(Boolean);
        if (key) env[name] = key;
        else delete env[name];
    }
}

module.exports = { TIER0, EXCLUDED_BY_DEFAULT, tier0, defaultMatrix, applyModelEnv, applyPlatformEnv };
