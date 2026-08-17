/**
 * Maps a resolved BYOK model slot to a Vercel AI SDK LanguageModel, with a
 * structured-output retry-on-error wrapper for OpenAI-compatible upstreams.
 *
 * The env/managed default-model cascade moved to ./managed-slot and the
 * managed/trial constants to ./byok-defaults (Wave 4, SRP); both are re-exported
 * here so existing `@libs/llm/byok-to-vercel` import paths keep working.
 */
import type { LanguageModel } from 'ai';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { decrypt } from '@libs/common/utils/crypto';
// Provider registry (Phase 1): every BYOK provider resolves through REGISTRY.
// Importing the barrel registers all provider modules via side effect.
import { REGISTRY } from '@libs/llm/providers';
import {
    resolveManagedSlot,
    resolveEnvProvider,
    hasManagedModelKey,
    type ByokModelOptions,
} from './managed-slot';
import { DEFAULT_MODEL, KODUS_DEFAULT_MODEL } from './byok-defaults';

// Wave 2: the concurrency / rpm / tpm-reservoir / cooldown limiter moved to
// ./byok-limiter. Re-exported here so existing import paths keep working.
export {
    BYOKConcurrencyLimiter,
    getLimiterForSlot,
    runWithBYOKLimiter,
    __limiterCacheInternals,
} from './byok-limiter';

// Wave 4 split: env/managed default resolution → ./managed-slot; managed/trial
// constants + the "who pays" decision → ./byok-defaults. Re-exported for
// back-compat so `@libs/llm/byok-to-vercel` stays the stable import surface.
export { resolveManagedSlot, type ByokModelOptions } from './managed-slot';
export {
    KODUS_DEFAULT_MODEL,
    KODUS_TRIAL_MODEL,
    trialDefaultModel,
} from './byok-defaults';

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

    // Same single-source cascade the model is BUILT from (resolveManagedSlot),
    // so the telemetry name always matches the model actually used.
    const env = resolveEnvProvider();
    if (env) {
        return `${env.name}:${process.env.API_LLM_PROVIDER_MODEL}`;
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
 *    Kodus-funded model is ALWAYS the managed `KODUS_DEFAULT_MODEL`
 *    (Fireworks-hosted deepseek-v4-flash); it is NEVER gpt/gemini. Env + cloud
 *    provider selection lives in the single place
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
    // or — in cloud — the Kodus-funded Fireworks default. Fail-soft: null when no
    // key backs that model, so the caller skips the pass instead of erroring.
    if (!hasManagedModelKey()) {
        return null;
    }
    return buildModelFromSlot(undefined, options, KODUS_DEFAULT_MODEL);
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
