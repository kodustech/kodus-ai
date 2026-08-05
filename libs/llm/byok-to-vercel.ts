/**
 * Maps BYOKConfig to a Vercel AI SDK LanguageModel.
 *
 * This adapter converts the Kodus BYOK configuration (provider + apiKey + model)
 * into a Vercel AI SDK model instance that supports native function calling.
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    anthropicCompatibleRootURL,
    BYOKConfig,
    BYOKProvider,
} from '@kodus/kodus-common/llm';
import { decrypt } from '@libs/common/utils/crypto';

/**
 * Build a Vercel AI SDK model from a base64-encoded Google Service Account
 * JSON. Mirrors `packages/kodus-common/src/llm/providerAdapters/vertexAdapter.ts`
 * so self-hosted deployments using the same `API_VERTEX_AI_API_KEY` env var
 * format (base64 SA JSON) work on both the v2 engine and the v5 agent.
 *
 * Routes by model id: `claude-*` models on Vertex speak the Anthropic
 * Messages protocol (Vertex MaaS), not the Gemini protocol, so they need
 * `createVertexAnthropic` from `@ai-sdk/google-vertex/anthropic`. Every
 * other model id (Gemini) uses `createVertex`. Using `createVertex` for a
 * Claude model id builds a Gemini-protocol client and fails at call time.
 *
 * Returns null when the value is not a valid base64-encoded JSON with a
 * `project_id` — the caller should fall back to another provider path.
 */
/**
 * Parse a Google Service Account from either raw JSON or base64-encoded
 * JSON. Users routinely paste the SA JSON file contents directly; base64
 * of a JSON object always starts with `ey` (from `{"`), while raw JSON
 * starts with `{`, so the leading char disambiguates with no ambiguity.
 * Returns null when neither form yields valid JSON.
 */
function parseSaCredentials(input: string): { project_id?: string } | null {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    const jsonText = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf-8');
    try {
        return JSON.parse(jsonText) as { project_id?: string };
    } catch {
        return null;
    }
}

function vertexModelFromSaJson(
    saJsonOrBase64: string,
    modelId: string,
    locationOverride?: string,
): LanguageModel | null {
    try {
        const credentials = parseSaCredentials(saJsonOrBase64);
        if (!credentials?.project_id) return null;
        // Keep this helper pure: the caller is responsible for resolving
        // the region (BYOK config or env var) and passing it as
        // locationOverride. Default to the GLOBAL endpoint when omitted —
        // it serves every current Claude and Gemini model on Vertex and
        // routes dynamically, so users never have to know per-model region
        // availability. (Regional endpoints like us-central1 don't serve
        // Claude at all.)
        const location = locationOverride?.trim() || 'global';
        const settings = {
            project: credentials.project_id,
            location,
            googleAuthOptions: { credentials: credentials as any },
        };
        if (CLAUDE_MODEL_PATTERN.test(modelId)) {
            return createVertexAnthropic(settings)(modelId);
        }
        return createVertex(settings)(modelId);
    } catch {
        return null;
    }
}

const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;
const GEMINI_MODEL_PATTERN = /^gemini[-_]/i;

/**
 * Build a Vercel AI SDK model for Amazon Bedrock.
 *
 * Two auth paths, in priority order:
 *   1. Bearer API key (recommended) — single-token auth, released by AWS
 *      in 2025. `@ai-sdk/amazon-bedrock` accepts it via `apiKey` prop and
 *      takes precedence over any SigV4 config.
 *   2. Static IAM user credentials (SigV4) — legacy path, kept for teams
 *      that haven't migrated to API keys or that prefer IAM policies.
 *
 * Returns a LanguageModel that will emit a clear auth error at call time
 * when credentials are missing — we don't pre-validate here because the
 * test-byok endpoint already catches empty fields before save.
 */
function bedrockModelFromCredentials(
    config: BYOKConfig['main'] | BYOKConfig['fallback'],
    modelId: string,
): LanguageModel {
    const region = config?.awsRegion?.trim() || 'us-east-1';

    if (config?.awsBearerToken?.trim()) {
        return createAmazonBedrock({
            region,
            apiKey: decrypt(config.awsBearerToken),
        })(modelId);
    }

    const accessKeyId = config?.awsAccessKeyId
        ? decrypt(config.awsAccessKeyId)
        : '';
    const secretAccessKey = config?.awsSecretAccessKey
        ? decrypt(config.awsSecretAccessKey)
        : '';
    const sessionToken = config?.awsSessionToken
        ? decrypt(config.awsSessionToken)
        : undefined;

    return createAmazonBedrock({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
    })(modelId);
}

/**
 * When the user sets `API_OPENAI_FORCE_BASE_URL` to a non-native endpoint
 * (OpenRouter, LiteLLM, Azure, DashScope, etc.), the intent is to route
 * through an OpenAI-compatible proxy regardless of the model name prefix.
 * In that case the native SDK auto-detect by model prefix is wrong — the
 * proxy only speaks the OpenAI Chat Completions protocol and the key the
 * user supplied belongs to the proxy, not to Anthropic/Google.
 *
 * Rule:
 *   - empty baseURL                            → native auto-detect is safe
 *   - baseURL contains "api.anthropic.com"     → still Anthropic native (explicit but native)
 *   - any other non-empty baseURL              → force OpenAI-compatible
 *
 * Vertex uses SA JSON auth (no baseURL), so its auto-detect is also gated
 * here: if the user explicitly overrode the URL, they are not going via
 * Vertex even if they have a Vertex key configured.
 */
function isProxyBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    return !/(^|\/\/)api\.anthropic\.com\b/i.test(baseURL);
}

/**
 * Default model config when no BYOK is configured.
 */
const DEFAULT_MODEL = {
    provider: BYOKProvider.OPENAI_COMPATIBLE,
    model: 'kimi-k2.7-code',
};

/**
 * Convert a BYOKConfig to a Vercel AI SDK LanguageModel.
 *
 * Supports all BYOKProvider types:
 * - OPENAI → @ai-sdk/openai
 * - ANTHROPIC → @ai-sdk/anthropic
 * - GOOGLE_GEMINI → @ai-sdk/google
 * - GOOGLE_VERTEX → @ai-sdk/google-vertex
 * - OPEN_ROUTER → @ai-sdk/openai-compatible (OpenRouter is OpenAI-compatible)
 * - OPENAI_COMPATIBLE → @ai-sdk/openai-compatible
 * - NOVITA → @ai-sdk/openai-compatible
 *
 * `options.structuredOutputs` opts the OpenAI-compatible branches into
 * `response_format: { type: "json_schema", json_schema: { schema, strict } }`
 * by setting `supportsStructuredOutputs: true` on the provider. Scope this
 * per-call to `generateObject` / `generateText({ output: Output.object })`
 * sites — leaving it off keeps the agentic tool-call loop on the unchanged
 * `json_object` (or absent) `response_format` path. Native SDKs
 * (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`,
 * `@ai-sdk/google-vertex`, `@ai-sdk/amazon-bedrock`) handle structured
 * outputs natively without any flag and are not affected by this option.
 *
 * Even when the caller opts in, the flag is gated by
 * `shouldEnableJsonSchema()` — only known-good provider/model/baseURL
 * combinations actually flip it on. Unknown OpenAI-compatible
 * upstreams (DeepSeek, Grok, random Novita models) fall back to the
 * SDK's `response_format: { type: "json_object" }` path, which is
 * slow but works. Call sites should pair the flag with a
 * retry-on-error wrapper that catches a wrong allowlist guess.
 */
export type ByokModelOptions = {
    structuredOutputs?: boolean;
};

const OPENROUTER_JSON_SCHEMA_PREFIXES = [
    'openai/',
    'anthropic/',
    'google/',
    'moonshotai/',
];

/**
 * Conservative capability gate for `supportsStructuredOutputs: true` on
 * `@ai-sdk/openai-compatible` providers. Returns true only when we have
 * strong evidence the upstream honors strict `response_format: json_schema`.
 * Anything else returns false so the SDK falls back to `json_object` and
 * the upstream sees the same request shape it always saw.
 *
 * Self-hosted env mode (`API_LLM_PROVIDER_MODEL`) is handled by its own
 * branch in `byokToVercelModel`/`getInternalModel` — it's an explicit
 * customer-controlled deployment, so we trust the caller's opt-in there.
 */
function shouldEnableJsonSchema(
    provider: BYOKProvider,
    model: string,
    baseURL?: string,
): boolean {
    if (provider === BYOKProvider.OPEN_ROUTER) {
        return OPENROUTER_JSON_SCHEMA_PREFIXES.some((p) =>
            model.toLowerCase().startsWith(p),
        );
    }
    if (provider === BYOKProvider.OPENAI_COMPATIBLE) {
        if (!baseURL) return false;
        // vLLM defaults to port 8000 and the issue's target case.
        if (/:8000(\/|$)/.test(baseURL)) return true;
        // Opt-in comma-separated allowlist of substrings, e.g.
        // "vllm.internal,my-llm-proxy.example.com". Set by ops when
        // running behind a non-vLLM but schema-capable proxy.
        const allowList = process.env.API_TRUST_JSON_SCHEMA_BASE_URLS;
        if (allowList) {
            const needles = allowList
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (needles.some((needle) => baseURL.includes(needle))) return true;
        }
        return false;
    }
    // NOVITA varies wildly by upstream — too risky to enable by default.
    // Unknown / fallback openai-compatible: same.
    return false;
}

export function byokToVercelModel(
    byokConfig?: BYOKConfig,
    role: 'main' | 'fallback' = 'main',
    options: ByokModelOptions = {},
    /**
     * Override the hardcoded `DEFAULT_MODEL.model` when there's no BYOK
     * config. Used by the public-demo / trial flow to force a cheaper
     * model (gemini-2.5-flash) for anonymous reviews — the production
     * default of gemini-3.1-pro-preview is ~5–10× slower and overkill
     * for a free demo.
     */
    defaultModelOverride?: string,
): LanguageModel {
    const config =
        role === 'fallback' ? byokConfig?.fallback : byokConfig?.main;

    if (!config) {
        const defaultModel = defaultModelOverride || DEFAULT_MODEL.model;
        // No BYOK — pick the default based on deployment mode.
        // Self-hosted: honor `API_LLM_PROVIDER_MODEL` (+ `API_OPEN_AI_API_KEY` /
        //   `API_OPENAI_FORCE_BASE_URL` / `API_VERTEX_AI_API_KEY`) so the
        //   customer's own keys from .env drive the main model, the same way
        //   `getInternalModel` does for helper calls.
        // Cloud (managed/trial): fall back to Kodus's bundled Gemini default
        //   (`DEFAULT_MODEL.model` → v5 agent-first uses
        //   gemini-3.1-pro-preview-customtools; legacy v2 stays on
        //   gemini-2.5-pro via `LLMModelProvider` enum in llmAnalysis.service).
        const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
        if (envMode !== 'auto') {
            // Auto-detect the target provider from the configured model id.
            // Same envs (`API_LLM_PROVIDER_MODEL` + `API_OPEN_AI_API_KEY` +
            // `API_OPENAI_FORCE_BASE_URL` + `API_VERTEX_AI_API_KEY`) work for
            // every supported provider — the prefix of the model name picks
            // the right SDK so tools/auth/protocol match:
            //   gemini-*  → Vertex (SA JSON in API_VERTEX_AI_API_KEY)
            //   claude-*  → Anthropic native (API_OPEN_AI_API_KEY) when set,
            //               else Vertex Anthropic (SA JSON in API_VERTEX_AI_API_KEY)
            //   any other → OpenAI-compatible (OpenAI, Moonshot, z.AI, etc.)
            const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
            const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
            const openaiKey = process.env.API_OPEN_AI_API_KEY;
            const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
            const vertexKey = process.env.API_VERTEX_AI_API_KEY;
            const googleAiStudioKey =
                process.env.API_GOOGLE_AI_API_KEY ||
                process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            const viaProxy = isProxyBaseURL(openaiBaseURL);

            if (isGemini && !viaProxy) {
                // Order of preference:
                //   1. Explicit AI Studio key (API_GOOGLE_AI_API_KEY) — cheap,
                //      free-tier style key the user typed on purpose.
                //   2. Vertex SA JSON (API_VERTEX_AI_API_KEY, base64 encoded)
                //      — enterprise path, matches the v2 VertexAdapter.
                //   3. If API_VERTEX_AI_API_KEY is set but isn't a base64 SA
                //      JSON, treat it as a plain AI Studio key (users often
                //      paste an AIzaSy… key into the Vertex slot because of
                //      the historical env var name).
                if (googleAiStudioKey) {
                    return createGoogleGenerativeAI({
                        apiKey: googleAiStudioKey,
                    })(envMode);
                }
                if (vertexKey) {
                    const vertexModel = vertexModelFromSaJson(
                        vertexKey,
                        envMode,
                        process.env.API_VERTEX_AI_LOCATION,
                    );
                    if (vertexModel) return vertexModel;
                    return createGoogleGenerativeAI({ apiKey: vertexKey })(
                        envMode,
                    );
                }
                // No Google-side key at all — fall through to the cloud
                // Gemini default below.
            }
            if (isClaude && openaiKey && !viaProxy) {
                return createAnthropic({
                    apiKey: openaiKey,
                    // Anthropic SDK defaults to api.anthropic.com/v1 when
                    // baseURL is omitted; forward the env override only
                    // when the user explicitly points at Anthropic.
                    ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
                })(envMode);
            }
            if (isClaude && vertexKey && !viaProxy) {
                // Claude on Vertex (MaaS): the SA JSON in API_VERTEX_AI_API_KEY
                // routes through @ai-sdk/google-vertex/anthropic. Only reached
                // when no direct Anthropic key (API_OPEN_AI_API_KEY) is set —
                // that native path above takes precedence.
                const vertexModel = vertexModelFromSaJson(
                    vertexKey,
                    envMode,
                    process.env.API_VERTEX_AI_LOCATION,
                );
                if (vertexModel) return vertexModel;
            }
            if (openaiKey) {
                return createOpenAICompatible({
                    name: 'self-hosted',
                    apiKey: openaiKey,
                    // `@ai-sdk/openai-compatible` has no default baseURL
                    // (unlike `@ai-sdk/openai`), so an empty value throws
                    // "Invalid URL" on the first request. Default to
                    // api.openai.com to match the legacy v2 getChatGPT
                    // behavior when no custom endpoint is configured.
                    baseURL: openaiBaseURL || 'https://api.openai.com/v1',
                    supportsStructuredOutputs:
                        options.structuredOutputs === true,
                })(envMode);
            }
            // self-hosted mode declared but no usable env key — fall through
            // to the Gemini default so the call still has a model to attach
            // (it'll fail fast on the API call instead of here).
        }

        // Kimi (Moonshot AI) — used by the public-demo trial flow.
        // Detected by model-name prefix so we don't need a new BYOK
        // provider entry just for the default-only path. Wires through
        // the OpenAI-compatible adapter pointed at Moonshot's endpoint.
        if (/^kimi[-_.]/i.test(defaultModel)) {
            const moonshotKey =
                process.env.API_MOONSHOT_API_KEY ||
                process.env.MOONSHOT_API_KEY ||
                '';
            return createOpenAICompatible({
                name: 'moonshot',
                apiKey: moonshotKey,
                baseURL: 'https://api.moonshot.ai/v1',
            })(defaultModel);
        }

        const googleKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            '';
        return createGoogleGenerativeAI({ apiKey: googleKey })(
            defaultModel,
        );
    }

    const { provider, model, baseURL } = config;
    const apiKey = decrypt(config.apiKey);

    switch (provider) {
        case BYOKProvider.OPENAI:
            return createOpenAI({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.ANTHROPIC:
            return createAnthropic({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.ANTHROPIC_COMPATIBLE:
            // Anthropic-compatible endpoints (Kimi Code, Z.ai, DeepSeek):
            // @ai-sdk/anthropic appends /messages to the base, so the base
            // must carry the /v1 suffix — normalize whatever the user pasted.
            return createAnthropic({
                apiKey,
                baseURL: `${anthropicCompatibleRootURL(baseURL || '')}/v1`,
            })(model);

        case BYOKProvider.GOOGLE_GEMINI:
            return createGoogleGenerativeAI({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.OPEN_ROUTER:
            return createOpenAICompatible({
                name: 'open-router',
                apiKey,
                baseURL: baseURL || 'https://openrouter.ai/api/v1',
                supportsStructuredOutputs:
                    options.structuredOutputs === true &&
                    shouldEnableJsonSchema(provider, model, baseURL),
            })(model);

        case BYOKProvider.OPENAI_COMPATIBLE:
            return createOpenAICompatible({
                name: 'openai-compatible',
                apiKey,
                baseURL: baseURL || '',
                supportsStructuredOutputs:
                    options.structuredOutputs === true &&
                    shouldEnableJsonSchema(provider, model, baseURL),
            })(model);

        case BYOKProvider.NOVITA:
            return createOpenAICompatible({
                name: 'novita',
                apiKey,
                baseURL: baseURL || 'https://api.novita.ai/v3/openai',
                supportsStructuredOutputs:
                    options.structuredOutputs === true &&
                    shouldEnableJsonSchema(provider, model, baseURL),
            })(model);

        case BYOKProvider.GOOGLE_VERTEX: {
            // BYOK Vertex keys are stored as base64-encoded Service Account
            // JSON (matching the format used by the v2 VertexAdapter).
            // Use `@ai-sdk/google-vertex` with the SA credentials; only fall
            // back to AI Studio if the value isn't a valid SA JSON (e.g. the
            // user typed a plain AIzaSy... key into the Vertex provider
            // slot — degraded but still usable).
            const vertexModel = vertexModelFromSaJson(
                apiKey,
                model,
                config.vertexLocation,
            );
            if (vertexModel) return vertexModel;
            return createGoogleGenerativeAI({ apiKey })(model);
        }

        case BYOKProvider.AMAZON_BEDROCK: {
            return bedrockModelFromCredentials(config, model);
        }

        default:
            // Unknown provider — try as OpenAI-compatible. Capability
            // gate is conservative for unknown providers (always false),
            // so we never silently send json_schema to an upstream we
            // can't reason about.
            return createOpenAICompatible({
                name: String(provider),
                apiKey,
                baseURL: baseURL || '',
                supportsStructuredOutputs:
                    options.structuredOutputs === true &&
                    shouldEnableJsonSchema(provider, model, baseURL),
            })(model);
    }
}

/**
 * Extract a human-readable model name from BYOK config.
 * Mirrors the fallback logic in `byokToVercelModel` so telemetry/logs
 * reflect the model that will actually be used.
 */
export function getModelName(
    byokConfig?: BYOKConfig,
    defaultModelOverride?: string,
): string {
    if (byokConfig?.main) {
        return `${byokConfig.main.provider}:${byokConfig.main.model}`;
    }

    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
    if (envMode !== 'auto') {
        const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
        const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
        const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
        const viaProxy = isProxyBaseURL(openaiBaseURL);
        const googleAiStudioKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (isGemini && !viaProxy) {
            if (googleAiStudioKey) {
                return `google_ai_studio:${envMode}`;
            }
            if (process.env.API_VERTEX_AI_API_KEY) {
                return `google_vertex:${envMode}`;
            }
        }
        if (isClaude && process.env.API_OPEN_AI_API_KEY && !viaProxy) {
            return `anthropic:${envMode}`;
        }
        if (isClaude && process.env.API_VERTEX_AI_API_KEY && !viaProxy) {
            return `google_vertex:${envMode}`;
        }
        if (process.env.API_OPEN_AI_API_KEY) {
            return `openai_compatible:${envMode}`;
        }
    }

    return defaultModelOverride || DEFAULT_MODEL.model;
}

/**
 * Get a cheap/fast model for internal operations (fallback structuring, dedup).
 *
 * Priority order:
 * 1. BYOK fallback/main model (client is paying)
 * 2. Self-hosted configured provider
 * 3. Cloud: OpenAI GPT-4.1-mini (best at structured output) → Gemini 2.5 Flash (fallback)
 */
export function getInternalModel(
    byokConfig?: BYOKConfig,
    options: ByokModelOptions = {},
): LanguageModel | null {
    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';

    // If BYOK is configured, use the client's fallback or main model
    if (byokConfig?.fallback) {
        return byokToVercelModel(byokConfig, 'fallback', options);
    }
    if (byokConfig?.main) {
        return byokToVercelModel(byokConfig, 'main', options);
    }

    // Self-hosted mode: match byokToVercelModel's provider selection so
    // main and internal calls route through the same SDK.
    if (envMode !== 'auto') {
        const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
        const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
        const openaiKey = process.env.API_OPEN_AI_API_KEY;
        const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
        const vertexKey = process.env.API_VERTEX_AI_API_KEY;
        const googleAiStudioKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        const viaProxy = isProxyBaseURL(openaiBaseURL);

        if (isGemini && !viaProxy) {
            if (googleAiStudioKey) {
                return createGoogleGenerativeAI({ apiKey: googleAiStudioKey })(
                    envMode,
                );
            }
            if (vertexKey) {
                const vertexModel = vertexModelFromSaJson(
                    vertexKey,
                    envMode,
                    process.env.API_VERTEX_AI_LOCATION,
                );
                if (vertexModel) return vertexModel;
                return createGoogleGenerativeAI({ apiKey: vertexKey })(envMode);
            }
        }
        if (isClaude && openaiKey && !viaProxy) {
            return createAnthropic({
                apiKey: openaiKey,
                ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
            })(envMode);
        }
        if (isClaude && vertexKey && !viaProxy) {
            // Claude on Vertex (MaaS) — see byokToVercelModel for rationale.
            const vertexModel = vertexModelFromSaJson(
                vertexKey,
                envMode,
                process.env.API_VERTEX_AI_LOCATION,
            );
            if (vertexModel) return vertexModel;
        }
        if (openaiKey) {
            return createOpenAICompatible({
                name: 'self-hosted',
                apiKey: openaiKey,
                baseURL: openaiBaseURL || 'https://api.openai.com/v1',
                supportsStructuredOutputs: options.structuredOutputs === true,
            })(envMode);
        }

        return null;
    }

    // Cloud mode: prefer OpenAI GPT-5-mini (excellent structured output), fall back to Gemini
    const openaiKey = process.env.API_OPEN_AI_API_KEY;
    if (openaiKey) {
        return createOpenAI({ apiKey: openaiKey })('gpt-5.4-mini');
    }

    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!googleKey) {
        return null;
    }

    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.5-flash');
}

export type BYOKLimiterRole = 'main' | 'fallback' | 'internal';

type BYOKProviderSlotConfig = NonNullable<BYOKConfig['main']>;

type QueuedTask<T> = {
    id: number;
    label: string;
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
    started: boolean;
    cancelled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    cleanup?: () => void;
};

const DEFAULT_LIMITER_QUEUE_TIMEOUT_MS = 0;

class BYOKConcurrencyLimiter {
    private readonly queue: Array<QueuedTask<unknown>> = [];
    private activeCount = 0;
    private nextTaskId = 1;

    constructor(readonly concurrency: number) {}

    /**
     * @param queueTimeoutMs Per-task queue wait timeout. When > 0, the task
     *   is rejected with [BYOK-QUEUE-TIMEOUT] if it cannot acquire a slot within
     *   this duration. Pass 0 (or omit) for infinite wait (review callers).
     *   Conversation callers pass 60_000 to fail fast when a review holds the slot.
     */
    run<T>(
        label: string,
        fn: () => Promise<T>,
        abortSignal?: AbortSignal,
        queueTimeoutMs = DEFAULT_LIMITER_QUEUE_TIMEOUT_MS,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask<T> = {
                id: this.nextTaskId++,
                label,
                run: fn,
                resolve,
                reject,
                started: false,
                cancelled: false,
            };

            const abortQueuedTask = () => {
                if (task.started || task.cancelled) return;
                task.cancelled = true;
                if (task.timer) clearTimeout(task.timer);
                const index = this.queue.findIndex(
                    (item) => item.id === task.id,
                );
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                reject(
                    abortSignal?.reason instanceof Error
                        ? abortSignal.reason
                        : new Error(
                              `[BYOK-QUEUE-ABORTED] ${label} was cancelled before acquiring an LLM concurrency slot`,
                          ),
                );
            };

            if (abortSignal) {
                if (abortSignal.aborted) {
                    abortQueuedTask();
                    return;
                }
                abortSignal.addEventListener('abort', abortQueuedTask, {
                    once: true,
                });
                task.cleanup = () =>
                    abortSignal.removeEventListener('abort', abortQueuedTask);
            }

            if (queueTimeoutMs > 0) {
                task.timer = setTimeout(() => {
                    if (task.started || task.cancelled) return;
                    task.cancelled = true;
                    task.cleanup?.();
                    const index = this.queue.findIndex(
                        (item) => item.id === task.id,
                    );
                    if (index >= 0) {
                        this.queue.splice(index, 1);
                    }
                    reject(
                        new Error(
                            `[BYOK-QUEUE-TIMEOUT] ${label} waited more than ${Math.round(
                                queueTimeoutMs / 1000,
                            )}s for an LLM concurrency slot`,
                        ),
                    );
                }, queueTimeoutMs);
            }

            this.queue.push(task as QueuedTask<unknown>);
            this.drain();
        });
    }

    private drain() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task || task.cancelled) continue;

            task.started = true;
            if (task.timer) clearTimeout(task.timer);
            task.cleanup?.();
            this.activeCount++;

            Promise.resolve()
                .then(() => task.run())
                .then(
                    (value) => task.resolve(value),
                    (error) => task.reject(error),
                )
                .finally(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this.drain();
                });
        }
    }
}

const limiterCache = new Map<string, BYOKConcurrencyLimiter>();

function getLimiterConfig(
    byokConfig?: BYOKConfig,
    role: BYOKLimiterRole = 'main',
): BYOKProviderSlotConfig | undefined {
    if (!byokConfig) return undefined;

    switch (role) {
        case 'fallback':
            return byokConfig.fallback;
        case 'internal':
            return byokConfig.fallback ?? byokConfig.main;
        case 'main':
        default:
            return byokConfig.main;
    }
}

function buildLimiterCacheKey(params: {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    role?: BYOKLimiterRole;
}): string | null {
    const role = params.role ?? 'main';
    const config = getLimiterConfig(params.byokConfig, role);
    if (!config) return null;

    const organizationScope = params.organizationId || 'global';
    return [
        organizationScope,
        config.provider,
        config.apiKey,
        config.baseURL || '',
        config.model,
    ].join('::');
}

/**
 * Runs a task through a BYOK concurrency limiter scoped by organization + provider account.
 *
 * The limiter is shared across main/internal/fallback calls when they hit the same
 * provider account, because upstream concurrency limits are account-wide rather than
 * call-type-specific.
 */
export function runWithBYOKLimiter<T>(
    params: {
        byokConfig?: BYOKConfig;
        organizationId?: string;
        role?: BYOKLimiterRole;
        queueTimeoutMs?: number;
        abortSignal?: AbortSignal;
    },
    fn: () => Promise<T>,
    label = 'llm-call',
): Promise<T> {
    const role = params.role ?? 'main';
    const config = getLimiterConfig(params.byokConfig, role);
    const maxConcurrent = config?.maxConcurrentRequests;

    if (!maxConcurrent || maxConcurrent <= 0) {
        return fn();
    }

    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) {
        return fn();
    }

    const queueTimeoutMs =
        params.queueTimeoutMs ?? DEFAULT_LIMITER_QUEUE_TIMEOUT_MS;
    let limiter = limiterCache.get(cacheKey);
    if (!limiter || limiter.concurrency !== maxConcurrent) {
        limiter = new BYOKConcurrencyLimiter(maxConcurrent);
        limiterCache.set(cacheKey, limiter);
    }

    return limiter.run(label, fn, params.abortSignal, queueTimeoutMs);
}

// ─── Structured-output retry-on-error ────────────────────────────────
// The allowlist in `shouldEnableJsonSchema` is conservative on purpose
// but can guess wrong: a model we trusted may stop honoring json_schema,
// or a custom proxy we trusted may be older than we thought. Rather
// than fail the call we mark the offending provider:model combination
// "json_schema-unsupported" in a process-scoped cache and retry once
// with the flag off (SDK downgrades to `response_format: json_object`,
// upstream accepts, slow path returns parseable text). Future calls
// for the same combo skip the doomed first attempt entirely.

const noJsonSchemaCache = new Set<string>();

function structuredFallbackCacheKey(byokConfig?: BYOKConfig): string {
    if (byokConfig?.fallback) {
        const f = byokConfig.fallback;
        return `${f.provider}:${f.model}:${f.baseURL ?? ''}`;
    }
    if (byokConfig?.main) {
        const m = byokConfig.main;
        return `${m.provider}:${m.model}:${m.baseURL ?? ''}`;
    }
    // Self-hosted env mode — cache by the configured model id; the
    // base URL is process-wide so we can elide it from the key.
    return `env:${process.env.API_LLM_PROVIDER_MODEL ?? 'auto'}`;
}

function isJsonSchemaUnsupportedError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    // Match common phrasings without depending on a specific provider.
    // OpenRouter, DeepSeek, Grok, Mistral, Novita upstreams all surface
    // some variant of these strings in their 4xx response body.
    const text = `${err.message ?? ''} ${(err as any).responseBody ?? ''}`;
    if (!text) return false;
    const haystack = text.toLowerCase();
    // Match BOTH a structured-output term AND an "unsupported"-ish
    // signal so we don't bail on unrelated 4xx errors.
    const mentionsSchema =
        haystack.includes('response_format') ||
        haystack.includes('json_schema') ||
        haystack.includes('structured output') ||
        haystack.includes('structured_output') ||
        haystack.includes('structured-output');
    if (!mentionsSchema) return false;
    const looksUnsupported =
        haystack.includes('unsupported') ||
        haystack.includes('not supported') ||
        haystack.includes('invalid') ||
        haystack.includes('must be') ||
        haystack.includes('supported values');
    if (!looksUnsupported) return false;
    // Also accept any 4xx — server-side validation rejecting the body.
    const status = (err as any).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
        return true;
    }
    // Some SDK wrappers don't surface statusCode (e.g. validation thrown
    // before the network call). Accept message-only matches too.
    return true;
}

export interface StructuredFallbackParams {
    byokConfig?: BYOKConfig;
    /** Optional label for logs when the retry actually fires. */
    label?: string;
    /**
     * Organization the call runs for. Scopes the no-json-schema cache so
     * one tenant's verdict never demotes another. Omit only for
     * process-wide self-hosted mode.
     */
    organizationId?: string;
}

/**
 * Run a structured-output LLM call, retrying without the
 * `supportsStructuredOutputs: true` flag if the upstream rejects the
 * `response_format: json_schema` body. Wrap the three review-pipeline
 * sites that use `generateText({ output: Output.object(...) })` or
 * `generateObject(...)`.
 *
 * The `exec` callback receives the resolved `LanguageModel` and is
 * expected to wire it into the SDK call (so the caller keeps control
 * over telemetry, abort signals, prompts, throttling, etc.). When the
 * first attempt fails with a schema-related error, the helper rebuilds
 * the model with the flag off and re-invokes `exec`. Other errors
 * propagate unchanged.
 *
 * Throws `NoStructuredFallbackModelError` when `getInternalModel`
 * returns null, mirroring the existing "no internal model available"
 * branch at each call site.
 */
export async function withStructuredOutputFallback<T>(
    params: StructuredFallbackParams,
    exec: (model: LanguageModel) => Promise<T>,
): Promise<T> {
    const cacheKey = structuredFallbackCacheKey(params.byokConfig);
    const tryStructured = !noJsonSchemaCache.has(cacheKey);

    const firstModel = getInternalModel(params.byokConfig, {
        structuredOutputs: tryStructured,
    });
    if (!firstModel) {
        throw new NoStructuredFallbackModelError();
    }

    // The retry only helps when the first attempt actually sent
    // `response_format: json_schema` — it downgrades that to
    // `json_object`. `getInternalModel` may have refused the flag
    // anyway (capability gate, or a non-OpenAI-compatible provider),
    // in which case there is nothing to downgrade and the retry would
    // resend a byte-identical request. `@ai-sdk/openai-compatible`
    // exposes the effective state as `model.supportsStructuredOutputs`;
    // it is undefined on native SDKs, which never need the retry.
    const sentJsonSchema =
        (firstModel as { supportsStructuredOutputs?: boolean })
            .supportsStructuredOutputs === true;

    try {
        return await exec(firstModel);
    } catch (err) {
        if (!sentJsonSchema || !isJsonSchemaUnsupportedError(err)) {
            throw err;
        }
        noJsonSchemaCache.add(cacheKey);
        const label = params.label ? ` for ${params.label}` : '';

        console.warn(
            `[STRUCTURED-OUTPUT-FALLBACK] Upstream rejected json_schema${label} (cacheKey=${cacheKey}). Retrying with response_format=json_object. Reason: ${(err as Error).message}`,
        );
        const retryModel = getInternalModel(params.byokConfig, {
            structuredOutputs: false,
        });
        if (!retryModel) {
            throw new NoStructuredFallbackModelError();
        }
        return await exec(retryModel);
    }
}

export class NoStructuredFallbackModelError extends Error {
    constructor() {
        super(
            'No internal model available for structured-output fallback (BYOK absent and no cloud/self-hosted key configured).',
        );
        this.name = 'NoStructuredFallbackModelError';
    }
}

// Internal — exported for tests in evals/structured-outputs/repro.ts.
export const __structuredFallbackInternals = {
    cache: noJsonSchemaCache,
    isJsonSchemaUnsupportedError,
    cacheKey: structuredFallbackCacheKey,
};
