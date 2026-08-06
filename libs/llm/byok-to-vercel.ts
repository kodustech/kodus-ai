/**
 * Maps NormalizedByokConfig to a Vercel AI SDK LanguageModel.
 *
 * This adapter converts the Kodus BYOK configuration (provider + apiKey + model)
 * into a Vercel AI SDK model instance that supports native function calling.
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { decrypt } from '@libs/common/utils/crypto';
// Provider registry (Phase 1): every BYOK provider resolves through REGISTRY.
// Importing the barrel registers all provider modules via side effect. The
// self-hosted / trial default-model paths below are NOT BYOK ids; most route
// through the registry too, with two inline exceptions in resolveManagedSlot
// (self-hosted OpenAI-compatible + DeepSeek default) the modules can't reproduce.
import { REGISTRY } from '@libs/llm/providers';

// Wave 2: the concurrency / rpm / tpm-reservoir / cooldown limiter moved to
// ./byok-limiter. Re-exported here so existing import paths keep working.
export {
    BYOKConcurrencyLimiter,
    getLimiterForSlot,
    runWithBYOKLimiter,
    __limiterCacheInternals,
} from './byok-limiter';

// Model-name protocol patterns, used by the self-hosted / trial default-model
// resolution below (the BYOK provider builders moved to the provider modules
// + libs/llm/model-builders.ts in Phase 1).
const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;
const GEMINI_MODEL_PATTERN = /^gemini[-_]/i;

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
 * The Kodus-funded model for the trial / no-BYOK (cloud) flow — the SINGLE
 * source of truth for the managed default id. Every entitlement flow that forces
 * "Kodus pays" (code-review trial/demo, Kody Rules generation, reference
 * detection, PR summary) references this instead of re-typing the id.
 */
export const KODUS_DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Default model config when no BYOK is configured.
 */
const DEFAULT_MODEL = {
    provider: BYOKProvider.OPENAI_COMPATIBLE,
    model: KODUS_DEFAULT_MODEL,
};

/**
 * Convert a NormalizedByokConfig to a Vercel AI SDK LanguageModel.
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

/**
 * Managed/env-default resolution result (Wave 3).
 *
 * The env-default path used to hand-roll every SDK factory inline. It now
 * resolves to one of two shapes so BOTH the managed and BYOK paths share the
 * SAME `REGISTRY.get(provider).build(...)` dispatch:
 *   - `kind: 'slot'` — a MANAGED `NormalizedModel` carrying a PLAINTEXT env
 *     apiKey (env keys are already plaintext — do NOT decrypt/encrypt them). The
 *     provider module reproduces the exact factory call the inline code made.
 *   - `kind: 'inline'` — a LanguageModel that `resolveManagedSlot` built itself
 *     because the provider module CANNOT reproduce this managed case without
 *     changing its own BYOK behavior. There is exactly one such documented
 *     exception (see below): the self-hosted OpenAI-compatible default.
 */
type ManagedResolution =
    | { kind: 'slot'; slot: NormalizedModel }
    | { kind: 'inline'; model: LanguageModel };

function managedSlot(
    provider: BYOKProvider,
    apiKey: string,
    model: string,
    extra?: Partial<NormalizedModel>,
): ManagedResolution {
    // MANAGED slot: the env apiKey is PLAINTEXT; buildModelFromSlot must NOT
    // decrypt it (decrypt is only for the ciphertext BYOK slot path).
    return { kind: 'slot', slot: { provider, apiKey, model, ...extra } };
}

/**
 * Resolve the env/managed/self-host default (the old `if (!config)` branch) to a
 * MANAGED slot routed through the registry, or to a pre-built inline exception.
 *
 * This is the SAME provider-selection logic the inline code had — the prefix of
 * `API_LLM_PROVIDER_MODEL` (or the default model) picks the SDK/auth/protocol:
 *   gemini-*  → google_gemini (AI Studio key) / google_vertex (SA JSON key)
 *   claude-*  → anthropic (native key) / google_vertex (Claude-on-Vertex SA JSON)
 *   any other → OpenAI-compatible (self-hosted) — the one INLINE exception
 * Cloud (managed/trial) falls back to the kimi/moonshot trial default (the
 * `moonshot` provider module) or the bundled Gemini default (`google_gemini`) —
 * both routed through the registry, not inline.
 *
 * Do NOT change this logic — it MUST stay behaviorally identical to the old
 * inline env-default branch (the env-default characterization tests pin it).
 */
export function resolveManagedSlot(
    defaultModel: string,
    options: ByokModelOptions,
): ManagedResolution {
    // Self-hosted: honor `API_LLM_PROVIDER_MODEL` (+ `API_OPEN_AI_API_KEY` /
    //   `API_OPENAI_FORCE_BASE_URL` / `API_VERTEX_AI_API_KEY`) so the customer's
    //   own keys from .env drive the main model, the same way `getInternalModel`
    //   does for helper calls.
    // Cloud (managed/trial): fall back to Kodus's bundled Gemini default
    //   (`DEFAULT_MODEL.model` → v5 agent-first uses
    //   gemini-3.1-pro-preview-customtools; legacy v2 stays on gemini-2.5-pro).
    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
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
            // Order of preference:
            //   1. Explicit AI Studio key (API_GOOGLE_AI_API_KEY) → google_gemini.
            //   2. Vertex SA JSON (API_VERTEX_AI_API_KEY, base64) → google_vertex.
            //   3. A plain AIzaSy… key pasted into the Vertex slot (NOT SA JSON):
            //      the google_vertex module's vertexModelFromSaJson returns null
            //      for it and falls back to createGoogleGenerativeAI({apiKey}) —
            //      EXACTLY the inline case-3 fall-through, so both 2 & 3 route
            //      through the ONE google_vertex slot (the module discriminates).
            if (googleAiStudioKey) {
                return managedSlot(
                    BYOKProvider.GOOGLE_GEMINI,
                    googleAiStudioKey,
                    envMode,
                );
            }
            if (vertexKey) {
                return managedSlot(BYOKProvider.GOOGLE_VERTEX, vertexKey, envMode, {
                    vertexLocation: process.env.API_VERTEX_AI_LOCATION,
                });
            }
            // No Google-side key — fall through to the cloud Gemini default below.
        }
        if (isClaude && openaiKey && !viaProxy) {
            // case-4b: forward the baseURL override ONLY when set. `!viaProxy`
            // guarantees it is empty or an api.anthropic.com host, so the
            // anthropic module forwards it verbatim (native) / omits it (default).
            return managedSlot(BYOKProvider.ANTHROPIC, openaiKey, envMode, {
                baseURL: openaiBaseURL || undefined,
            });
        }
        if (isClaude && vertexKey && !viaProxy) {
            // Claude on Vertex (MaaS): the google_vertex module's
            // vertexModelFromSaJson routes a claude-* id through
            // @ai-sdk/google-vertex/anthropic. Only reached when no direct
            // Anthropic key (API_OPEN_AI_API_KEY) is set — that native path above
            // takes precedence.
            return managedSlot(BYOKProvider.GOOGLE_VERTEX, vertexKey, envMode, {
                vertexLocation: process.env.API_VERTEX_AI_LOCATION,
            });
        }
        if (openaiKey) {
            // INLINE EXCEPTION (self-hosted OpenAI-compatible). The
            // openai_compatible provider module tags `name:'openai-compatible'`,
            // defaults an empty baseURL to '' (not api.openai.com), and gates
            // `supportsStructuredOutputs` through `shouldEnableJsonSchema` — none
            // of which match this managed path (name:'self-hosted', default
            // api.openai.com, raw structuredOutputs opt-in). Reproducing it would
            // change the module's BYOK behavior, so it stays inline (point 3(b)).
            return {
                kind: 'inline',
                model: createOpenAICompatible({
                    name: 'self-hosted',
                    apiKey: openaiKey,
                    // `@ai-sdk/openai-compatible` has no default baseURL (unlike
                    // `@ai-sdk/openai`), so an empty value throws "Invalid URL" on
                    // the first request. Default to api.openai.com to match the
                    // legacy v2 getChatGPT behavior when no endpoint is configured.
                    baseURL: openaiBaseURL || 'https://api.openai.com/v1',
                    supportsStructuredOutputs: options.structuredOutputs === true,
                })(envMode),
            };
        }
        // self-hosted mode declared but no usable env key — fall through to the
        // default below so the call still has a model to attach (it fails fast on
        // the API call instead of here).
    }

    // DeepSeek — the managed default model for the trial / no-BYOK flow.
    // Detected by model-name prefix so we don't need a new BYOK provider entry
    // just for the default-only path; wires through the OpenAI-compatible adapter
    // pointed at DeepSeek's endpoint (inline exception, like self-hosted above).
    if (/^deepseek[-_.]/i.test(defaultModel)) {
        const deepseekKey =
            process.env.API_DEEPSEEK_API_KEY ||
            process.env.DEEPSEEK_API_KEY ||
            '';
        return {
            kind: 'inline',
            model: createOpenAICompatible({
                name: 'deepseek',
                apiKey: deepseekKey,
                baseURL:
                    process.env.API_DEEPSEEK_BASE_URL ||
                    'https://api.deepseek.com/v1',
            })(defaultModel),
        };
    }

    // Kimi (Moonshot AI) — legacy managed default, kept for any lingering
    // `kimi-*` override still in flight. New default is DeepSeek above. Routes
    // through the moonshot registry module (createOpenAICompatible under the hood).
    if (/^kimi[-_.]/i.test(defaultModel)) {
        const moonshotKey =
            process.env.API_MOONSHOT_API_KEY ||
            process.env.MOONSHOT_API_KEY ||
            '';
        return managedSlot(BYOKProvider.MOONSHOT, moonshotKey, defaultModel);
    }

    // Cloud default (gemini) — routes through the google_gemini module like any
    // other managed slot (the module's build() calls
    // createGoogleGenerativeAI({apiKey})(defaultModel), identical to the old
    // inline path).
    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        '';
    return managedSlot(BYOKProvider.GOOGLE_GEMINI, googleKey, defaultModel);
}

/**
 * Build a Vercel AI SDK LanguageModel from ONE resolved model slot (slice 04b).
 *
 * BOTH construction paths now route through the registry: a `!slot` (managed /
 * no-BYOK / self-host) call resolves an env-default via `resolveManagedSlot` and
 * builds it with `REGISTRY.get(provider).build(...)`; a BYOK `slot` decrypts its
 * ciphertext apiKey and dispatches the same way. Only two managed cases the
 * provider modules can't reproduce (self-hosted openai-compat + moonshot) stay
 * as inline exceptions inside `resolveManagedSlot`.
 *
 * Secret hygiene: a BYOK `slot.apiKey` is ciphertext; `decrypt()` runs only in
 * this function's local scope and the plaintext is handed straight to the
 * provider builder — it never surfaces in a return value or a log. A MANAGED
 * slot from `resolveManagedSlot` carries a PLAINTEXT env key and is NOT
 * decrypted.
 */
export function buildModelFromSlot(
    slot?: NormalizedModel,
    options: ByokModelOptions = {},
    defaultModelOverride?: string,
): LanguageModel {
    if (!slot) {
        const resolved = resolveManagedSlot(
            defaultModelOverride || DEFAULT_MODEL.model,
            options,
        );
        // A MANAGED slot (plaintext env apiKey) routes through the same registry
        // build() as BYOK; an 'inline' resolution is a documented exception the
        // provider modules can't reproduce (see resolveManagedSlot).
        return resolved.kind === 'slot'
            ? REGISTRY.get(resolved.slot.provider).build(resolved.slot, options)
            : resolved.model;
    }

    // BYOK slot: `slot` carries the ENCRYPTED key; the module contract expects a
    // DECRYPTED apiKey, so pass the already-decrypted `apiKey` over the spread.
    // An unknown provider id throws a clear per-provider error (replacing the old
    // switch's silent openai-compatible default) — unreachable for the closed
    // BYOKProvider enum, but fail-loud.
    const apiKey = decrypt(slot.apiKey);
    return REGISTRY.get(slot.provider).build({ ...slot, apiKey }, options);
}

/**
 * Extract a human-readable model name from ONE resolved model slot.
 * Mirrors the env/default logic in `buildModelFromSlot` so telemetry/logs
 * reflect the model that will actually be used. A `undefined` slot resolves
 * the env/managed default name (the no-BYOK path), never a `.main`/`.fallback`
 * read.
 */
export function getModelName(
    slot?: NormalizedModel,
    defaultModelOverride?: string,
): string {
    if (slot) {
        return `${slot.provider}:${slot.model}`;
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
 * Get a cheap/fast model for internal / secondary-pass operations (dedup,
 * severity, suggestion formatting, structured-output fallback). ONE resolution,
 * shared with the main path — there is no hand-rolled provider tree here:
 *
 * 1. A resolved BYOK slot the caller passes → the client key (client pays).
 * 2. No slot → `resolveManagedSlot` (inside `buildModelFromSlot`): the
 *    self-hosted env model, or — in cloud — the Kodus-funded default. The
 *    Kodus-funded model is ALWAYS DeepSeek (`KODUS_DEFAULT_MODEL`); it is NEVER
 *    gpt/gemini. Env + cloud provider selection lives in the single place
 *    (`resolveManagedSlot`), so this stays a thin wrapper over the same builder.
 *
 * Fail-soft: returns null when no key backs the managed model, so a secondary
 * pass skips (keeps agent values) instead of erroring on an empty-key call.
 */

export function getInternalModel(
    slot?: NormalizedModel,
    options: ByokModelOptions = {},
): LanguageModel | null {
    // BYOK slot → the client key, built through the same builder as everything.
    if (slot) {
        return buildModelFromSlot(slot, options);
    }

    // No slot → the SAME managed resolution the main no-BYOK path uses
    // (resolveManagedSlot inside buildModelFromSlot): the self-hosted env model,
    // or — in cloud — the Kodus-funded DeepSeek default. Fail-soft: null when no
    // key backs that model, so the caller skips the pass instead of erroring.
    if (!hasManagedModelKey()) {
        return null;
    }
    return buildModelFromSlot(undefined, options, KODUS_DEFAULT_MODEL);
}

/**
 * Fail-soft guard for the no-BYOK internal path: is there a key backing the
 * managed model `resolveManagedSlot` would pick? Cloud → the Kodus-funded
 * DeepSeek key; self-hosted → whichever provider key the env model needs. Kept
 * deliberately coarse (any relevant key present) — the exact provider match is
 * `resolveManagedSlot`'s job; this only decides skip-vs-run.
 */
function hasManagedModelKey(): boolean {
    const selfHosted = (process.env.API_LLM_PROVIDER_MODEL ?? 'auto') !== 'auto';
    if (selfHosted) {
        return !!(
            process.env.API_OPEN_AI_API_KEY ||
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            process.env.API_VERTEX_AI_API_KEY
        );
    }
    return !!(process.env.API_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY);
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

function structuredFallbackCacheKey(slot?: NormalizedModel): string {
    if (slot) {
        return `${slot.provider}:${slot.model}:${slot.baseURL ?? ''}`;
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
    /** The ONE resolved model slot (ciphertext apiKey). The carrier read
     *  (`.main`) happens at the CONSUMER boundary — this helper never reads
     *  `.main`/`.fallback`. The withStructuredOutputFallback flow itself is
     *  revisited in 04b-05 alongside the fallback removal. */
    slot?: NormalizedModel;
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
    const cacheKey = structuredFallbackCacheKey(params.slot);
    const tryStructured = !noJsonSchemaCache.has(cacheKey);

    const firstModel = getInternalModel(params.slot, {
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
        const retryModel = getInternalModel(params.slot, {
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
