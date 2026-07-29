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
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BYOKProvider } from '@kodus/kodus-common/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { decrypt } from '@libs/common/utils/crypto';
import { vertexModelFromSaJson } from '@libs/llm/model-builders';
// Provider registry (Phase 1): every BYOK provider resolves through REGISTRY.
// Importing the barrel registers all provider modules via side effect. The
// self-hosted / trial default-model paths below are NOT BYOK ids and still
// build inline (they use vertexModelFromSaJson from the shared leaf).
import { REGISTRY } from '@libs/llm/providers';

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

/**
 * Build a Vercel AI SDK LanguageModel from ONE resolved model slot (slice 04b).
 *
 * This is the single-slot core extracted VERBATIM from the old
 * `byokToVercelModel` body: the `if (!slot)` branch is the env/managed/self-host
 * default path (managed org, no-BYOK, self-hosted `.env`), and the tail is the
 * BYOK registry build. Keyed on a single `slot` (a `NormalizedModel` carrying
 * ENCRYPTED apiKey ciphertext) instead of `role`-picking `.main`/`.fallback`.
 *
 * Secret hygiene: `slot.apiKey` is ciphertext; `decrypt()` runs only in this
 * function's local scope and the plaintext is handed straight to the provider
 * builder — it never surfaces in a return value or a log.
 *
 * Do NOT change the env-default logic — the `if (!slot)` branch IS the
 * managed/no-BYOK/self-host path and MUST stay behaviorally identical.
 */
export function buildModelFromSlot(
    slot?: NormalizedModel,
    options: ByokModelOptions = {},
    defaultModelOverride?: string,
): LanguageModel {
    const config = slot;

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

    const { provider } = config;
    const apiKey = decrypt(config.apiKey);

    // Every BYOK provider resolves through the registry (Phase 1 — the
    // BYOKProvider switch is gone). `config` carries the ENCRYPTED key; the
    // module contract expects a DECRYPTED apiKey, so pass the already-decrypted
    // `apiKey` over the spread. An unknown provider id throws a clear
    // per-provider error (replacing the old switch's silent openai-compatible
    // default) — unreachable for the closed BYOKProvider enum, but fail-loud.
    return REGISTRY.get(provider).build({ ...config, apiKey }, options);
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
 * Get a cheap/fast model for internal operations (structuring, dedup).
 *
 * Priority order:
 * 1. The resolved BYOK slot the caller passes (client is paying) — the caller
 *    owns which task-resolved slot an internal helper inherits; this builder
 *    never reads `.main`/`.fallback`.
 * 2. Self-hosted configured provider
 * 3. Cloud: OpenAI GPT-5-mini (best at structured output) → Gemini 2.5 Flash
 */
export function getInternalModel(
    slot?: NormalizedModel,
    options: ByokModelOptions = {},
): LanguageModel | null {
    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';

    // If a resolved BYOK slot is passed, build it directly (client is paying).
    if (slot) {
        return buildModelFromSlot(slot, options);
    }

    // Self-hosted mode: match buildModelFromSlot's provider selection so
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
    // tpm reservoir accounting (both undefined ⇒ no token gate for this task).
    // `estimatedTokens` is the PRE-call tiktoken estimate that debits the
    // reservoir at admission; `getUsageTokens` extracts the POST-call real total
    // from the task result so the reservoir reconciles the estimate against
    // actual usage after the call resolves.
    estimatedTokens?: number;
    getUsageTokens?: (result: T) => number | undefined;
};

const DEFAULT_LIMITER_QUEUE_TIMEOUT_MS = 0;

export class BYOKConcurrencyLimiter {
    private readonly queue: Array<QueuedTask<unknown>> = [];
    private activeCount = 0;
    private nextTaskId = 1;

    // rpm rate gate: min-interval (ms) between two actual task STARTS. 0 ⇒
    // disabled (concurrency-only, today's behavior). `lastStartAt` seeds to
    // -Infinity so the very first task starts immediately. `rateTimer` holds the
    // single pending re-drain scheduled while the rate window is closed.
    private concurrency: number;
    private minInterval = 0;
    private lastStartAt = Number.NEGATIVE_INFINITY;
    private rateTimer?: ReturnType<typeof setTimeout>;

    // tpm token reservoir: `tpmCapacity` (tokens/min) is the bucket size and the
    // per-minute refill rate; 0 ⇒ disabled (concurrency/rpm only). `reservoir`
    // holds the current available tokens (may go NEGATIVE when a single request's
    // real usage overshoots its estimate — reconcile debits the overshoot).
    // `reservoirRefillAt` timestamps the last linear refill. `tpmTimer` holds the
    // single pending re-drain scheduled while the reservoir is too low to admit
    // the head task (DELAY, never retry — mirrors the rpm rateTimer).
    private tpmCapacity = 0;
    private reservoir = 0;
    private reservoirRefillAt = 0;
    private tpmTimer?: ReturnType<typeof setTimeout>;

    // cooldown gate (429-armed): absolute timestamp until which NO new task may
    // start. 0 ⇒ never armed. `armCooldown(ms)` (called by the wrapper catch on a
    // classified RATE_LIMIT) pushes it to `Date.now() + ms`; drain() DELAYS every
    // admission while `Date.now() < cooldownUntil` (never a retry — a delay).
    // `cooldownTimer` holds the single pending re-drain scheduled at expiry so a
    // cooldown-only slot (Infinity concurrency, no rpm/tpm) still resumes.
    private cooldownUntil = 0;
    private cooldownTimer?: ReturnType<typeof setTimeout>;

    constructor(concurrency: number, rpm?: number, tpm?: number) {
        this.concurrency = concurrency;
        this.setRpm(rpm);
        this.setTpm(tpm);
    }

    /** Current concurrency ceiling (read by runWithBYOKLimiter for cache reuse). */
    getConcurrency(): number {
        return this.concurrency;
    }

    /**
     * Arm the cooldown gate for `ms` from now (called by the wrapper catch on a
     * classified RATE_LIMIT). Extends — never shortens — an active window, so
     * overlapping 429s don't cut a cooldown short. Non-finite/≤0 is ignored
     * (cooldownMs disabled ⇒ never arms). Schedules ONE re-drain at expiry so a
     * cooldown-only slot resumes without an external tick. Arming is a DELAY, not
     * a retry: it holds admissions; it never re-invokes any task.
     */
    armCooldown(ms: number): void {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
        const until = Date.now() + ms;
        if (until <= this.cooldownUntil) return; // never shorten an active window
        this.cooldownUntil = until;
        if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = undefined;
            this.drain();
        }, this.cooldownUntil - Date.now());
    }

    /** True while the cooldown window is still in the future. The retry owner
     *  (structured-review-call) consults this to skip re-issuing into a cooling
     *  slot. Reads no key material. */
    isInCooldown(): boolean {
        return this.cooldownUntil > Date.now();
    }

    /**
     * Re-tune a LIVE limiter without discarding its queue or in-flight rate
     * state (Pitfall 4). An unrelated config edit keyed on the same identity
     * fields updates the ceiling/interval on the cached instance rather than
     * constructing a new one that would reset `lastStartAt`.
     */
    configure(opts: {
        concurrency?: number;
        rpm?: number;
        tpm?: number;
    }): void {
        if (typeof opts.concurrency === 'number') {
            this.concurrency = opts.concurrency;
        }
        if ('rpm' in opts) {
            this.setRpm(opts.rpm);
        }
        if ('tpm' in opts) {
            this.setTpm(opts.tpm);
        }
        // A widened ceiling / disabled rate gate may unblock queued tasks.
        this.drain();
    }

    /** Compute the min-interval from rpm; guards against non-finite/≤0 → disabled. */
    private setRpm(rpm?: number): void {
        this.minInterval =
            typeof rpm === 'number' && Number.isFinite(rpm) && rpm > 0
                ? 60_000 / rpm
                : 0;
    }

    /**
     * Set/re-tune the token reservoir capacity. Guards non-finite/≤0 → disabled.
     * FIRST enable seeds the reservoir FULL (so an idle slot admits immediately).
     * A re-tune (config edit on a LIVE limiter) keeps the current balance —
     * capped at the new capacity — so an unrelated edit never refills a
     * mid-throttle reservoir (Pitfall 4). tpm is NOT a limiter identity field;
     * `buildLimiterCacheKey` is unchanged, so this re-tunes the cached instance.
     */
    private setTpm(tpm?: number): void {
        const capacity =
            typeof tpm === 'number' && Number.isFinite(tpm) && tpm > 0 ? tpm : 0;
        if (capacity === 0) {
            this.tpmCapacity = 0;
            return;
        }
        const wasDisabled = this.tpmCapacity === 0;
        this.tpmCapacity = capacity;
        if (wasDisabled) {
            // Seed FULL on first enable so an idle slot is not throttled.
            this.reservoir = capacity;
            this.reservoirRefillAt = Date.now();
        } else {
            // Re-tune: preserve the in-flight balance, capped at new capacity.
            this.reservoir = Math.min(this.reservoir, capacity);
        }
    }

    /** Linearly refill the reservoir (tokens += capacity * elapsedMs / 60000),
     *  capped at capacity. No-op when tpm is disabled. */
    private refillReservoir(): void {
        if (this.tpmCapacity <= 0) return;
        const now = Date.now();
        const elapsed = now - this.reservoirRefillAt;
        if (elapsed <= 0) return;
        this.reservoir = Math.min(
            this.tpmCapacity,
            this.reservoir + (this.tpmCapacity * elapsed) / 60_000,
        );
        this.reservoirRefillAt = now;
    }

    /**
     * Admission gate: refill, then DEBIT `estimate` if the reservoir holds enough.
     * `required` is clamped to capacity so a single request larger than the whole
     * bucket still admits once the reservoir is full (never a deadlock) — its
     * overshoot simply drives the balance negative, throttling the next request.
     * Returns true when admitted (and debited), false when the caller must wait.
     */
    private tryDebitReservoir(estimate: number): boolean {
        if (this.tpmCapacity <= 0 || estimate <= 0) return true;
        this.refillReservoir();
        const required = Math.min(estimate, this.tpmCapacity);
        if (this.reservoir >= required) {
            this.reservoir -= estimate;
            return true;
        }
        return false;
    }

    /** Milliseconds until the reservoir refills enough to admit `estimate`. */
    private reservoirDelayMs(estimate: number): number {
        const required = Math.min(estimate, this.tpmCapacity);
        const deficit = required - this.reservoir;
        if (deficit <= 0) return 0;
        return Math.ceil((deficit * 60_000) / this.tpmCapacity);
    }

    /**
     * POST-call correction: the admission step debited the pre-call `estimate`;
     * adjust by (estimate − actual) so the NET debit equals the real usage. An
     * over-estimate credits tokens back (capped at capacity — never bank beyond
     * the bucket); an under-estimate debits the shortfall (may go negative).
     */
    private reconcileReservoir(estimate: number, actual: number): void {
        if (this.tpmCapacity <= 0 || estimate <= 0) return;
        this.refillReservoir();
        this.reservoir = Math.min(
            this.tpmCapacity,
            this.reservoir + (estimate - actual),
        );
    }

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
        estimatedTokens?: number,
        getUsageTokens?: (result: T) => number | undefined,
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
                estimatedTokens,
                getUsageTokens,
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
            // Drop a cancelled head WITHOUT consuming a rate/token slot.
            if (this.queue[0].cancelled) {
                this.queue.shift();
                continue;
            }

            // cooldown gate (429-armed): after a classified RATE_LIMIT the slot
            // is HELD until `cooldownUntil`. DELAY (never retry) — schedule ONE
            // re-drain at expiry and stop starting. Checked FIRST (before rpm/tpm)
            // because a rate-limited provider must not be touched at all; it
            // coexists with rpm/tpm on the same instance (arming doesn't reset
            // the rpm window or the tpm reservoir — Pitfall 4).
            if (this.cooldownUntil > Date.now()) {
                if (!this.cooldownTimer) {
                    this.cooldownTimer = setTimeout(() => {
                        this.cooldownTimer = undefined;
                        this.drain();
                    }, this.cooldownUntil - Date.now());
                }
                return;
            }

            // rpm rate gate: DELAY (never retry) the next START if the min-interval
            // since the last actual start hasn't elapsed. Schedule a single
            // re-drain for the remaining time and stop starting early.
            if (this.minInterval > 0) {
                const elapsed = Date.now() - this.lastStartAt;
                if (elapsed < this.minInterval) {
                    if (!this.rateTimer) {
                        this.rateTimer = setTimeout(() => {
                            this.rateTimer = undefined;
                            this.drain();
                        }, this.minInterval - elapsed);
                    }
                    return;
                }
            }

            // tpm token gate: DEBIT the head task's pre-call estimate from the
            // reservoir. If the reservoir can't cover it yet, schedule ONE
            // re-drain for the refill delay and stop (DELAY, never retry) —
            // exactly like the rpm gate. Composes with rpm + concurrency: all
            // three gates guard the SAME per-slot limiter.
            const head = this.queue[0];
            const estimate = head.estimatedTokens ?? 0;
            if (
                this.tpmCapacity > 0 &&
                estimate > 0 &&
                !this.tryDebitReservoir(estimate)
            ) {
                if (!this.tpmTimer) {
                    this.tpmTimer = setTimeout(() => {
                        this.tpmTimer = undefined;
                        this.drain();
                    }, this.reservoirDelayMs(estimate));
                }
                return;
            }

            const task = this.queue.shift()!;

            task.started = true;
            if (task.timer) clearTimeout(task.timer);
            task.cleanup?.();
            // Stamp the start only when a task ACTUALLY starts (cancelled heads
            // are dropped above without consuming a rate/token slot).
            this.lastStartAt = Date.now();
            this.activeCount++;

            Promise.resolve()
                .then(() => task.run())
                .then(
                    (value) => {
                        // POST-call reconcile: correct the reservoir by
                        // (estimate − actual) from the real usage total BEFORE
                        // the finally re-drain, so the corrected balance gates
                        // the next task. Skip when usage is unavailable — the
                        // pre-call estimate then stands as the net debit.
                        if (
                            this.tpmCapacity > 0 &&
                            (task.estimatedTokens ?? 0) > 0
                        ) {
                            const actual = task.getUsageTokens?.(value);
                            if (typeof actual === 'number' && actual >= 0) {
                                this.reconcileReservoir(
                                    task.estimatedTokens as number,
                                    actual,
                                );
                            }
                        }
                        task.resolve(value);
                    },
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

function buildLimiterCacheKey(params: {
    slot?: NormalizedModel;
    organizationId?: string;
}): string | null {
    const config = params.slot;
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
 * Reach the cached per-slot limiter for a slot (same identity key
 * `runWithBYOKLimiter` uses), or null when none exists yet. The wrapper catch
 * uses it to `armCooldown` on a classified RATE_LIMIT; the retry owner
 * (structured-review-call) uses it to `isInCooldown()` before re-issuing. Never
 * constructs a limiter — a slot that never ran has no cached limiter (null).
 * Reads/returns no key material beyond the opaque ciphertext already in the slot.
 */
export function getLimiterForSlot(params: {
    slot?: NormalizedModel;
    organizationId?: string;
}): BYOKConcurrencyLimiter | null {
    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) return null;
    return limiterCache.get(cacheKey) ?? null;
}

/**
 * Runs a task through a BYOK concurrency limiter scoped by organization + provider account.
 *
 * The limiter keys off the ONE resolved slot passed in — no `.main`/`.fallback`
 * role switch. Calls hitting the same provider account share a limiter because
 * upstream concurrency limits are account-wide rather than call-type-specific.
 */
export function runWithBYOKLimiter<T>(
    params: {
        slot?: NormalizedModel;
        organizationId?: string;
        queueTimeoutMs?: number;
        abortSignal?: AbortSignal;
        /** PRE-call tiktoken estimate of the request's prompt tokens. Debits the
         *  tpm reservoir at admission. Supplied by the wrapper (the only seam
         *  with params.prompt); omit for a non-tpm call (zero overhead). */
        estimatedTokens?: number;
        /** Extracts the POST-call real token total from the task result so the
         *  reservoir reconciles estimate vs actual. Supplied by the wrapper (the
         *  only seam with doGenerate().usage). */
        getUsageTokens?: (result: T) => number | undefined;
    },
    fn: () => Promise<T>,
    label = 'llm-call',
): Promise<T> {
    const maxConcurrent = params.slot?.maxConcurrentRequests;
    const rpm = params.slot?.rpm;
    const tpm = params.slot?.tpm;
    const cooldownMs = params.slot?.cooldownMs;

    const hasConcurrency = !!maxConcurrent && maxConcurrent > 0;
    const hasRpm = !!rpm && rpm > 0;
    const hasTpm = !!tpm && tpm > 0;
    // A cooldown-capable slot must NOT fast-path even before any 429: it needs a
    // cached limiter so the wrapper catch can arm it and the retry owner can
    // query it. The gate stays inert (cooldownUntil=0) until actually armed.
    const hasCooldown = !!cooldownMs && cooldownMs > 0;

    // Fast path ONLY when ALL gates are unset — identical to pre-rpm behavior.
    if (!hasConcurrency && !hasRpm && !hasTpm && !hasCooldown) {
        return fn();
    }

    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) {
        return fn();
    }

    // An rpm-only OR tpm-only slot has no concurrency cap: the drain gate is
    // `activeCount < concurrency`, so `concurrency` MUST be Infinity (unbounded)
    // when maxConcurrentRequests is unset/≤0 — otherwise `0 < undefined` is
    // false and the queue never starts (deadlock). With Infinity the concurrency
    // gate is a no-op and only the rpm min-interval / tpm reservoir throttles.
    const concurrency = hasConcurrency ? (maxConcurrent as number) : Infinity;

    const queueTimeoutMs =
        params.queueTimeoutMs ?? DEFAULT_LIMITER_QUEUE_TIMEOUT_MS;
    let limiter = limiterCache.get(cacheKey);
    if (!limiter) {
        limiter = new BYOKConcurrencyLimiter(concurrency, rpm, tpm);
        limiterCache.set(cacheKey, limiter);
    } else {
        // Re-tune the cached limiter (identity fields unchanged) instead of
        // constructing a new one that would discard in-flight queue/rate/token
        // state (Pitfall 4). A config edit re-tunes; it never resets the throttle
        // or reseeds the reservoir. tpm is NOT an identity field.
        limiter.configure({ concurrency, rpm, tpm });
    }

    return limiter.run(
        label,
        fn,
        params.abortSignal,
        queueTimeoutMs,
        params.estimatedTokens,
        params.getUsageTokens,
    );
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
