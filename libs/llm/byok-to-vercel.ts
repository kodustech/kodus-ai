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
import { resolveManagedSlot, type ByokModelOptions } from './managed-slot';
import { DEFAULT_MODEL } from './byok-defaults';

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
export {
    resolveManagedSlot,
    // getModelName lives next to the env cascade it mirrors (so a telemetry-only
    // caller doesn't have to pull in the provider REGISTRY this file builds
    // from); re-exported here since `@libs/llm/byok-to-vercel` is its stable
    // import surface.
    getModelName,
    type ByokModelOptions,
} from './managed-slot';
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
    const codexAccessToken = slot.codexAccessToken
        ? decrypt(slot.codexAccessToken)
        : undefined;
    const codexRefreshToken = slot.codexRefreshToken
        ? decrypt(slot.codexRefreshToken)
        : undefined;
    return REGISTRY.get(slot.provider).build(
        {
            ...slot,
            apiKey,
            codexAccessToken,
            codexRefreshToken,
        },
        options,
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

/**
 * True when the slot may still send `response_format: json_schema` — i.e. its
 * provider has NOT been proven to reject it this process. A structured call
 * consults this before building so a known-bad provider skips json_schema and
 * goes straight to json_object. Shared with `withStructuredOutputFallback` (the
 * same `noJsonSchemaCache`) so the executor and the legacy helper agree.
 */
export function mayUseJsonSchema(slot?: NormalizedModel): boolean {
    return !noJsonSchemaCache.has(structuredFallbackCacheKey(slot));
}

/** Record that the slot's provider rejected json_schema — future structured
 *  calls for it skip straight to json_object. */
export function markJsonSchemaUnsupported(slot?: NormalizedModel): void {
    noJsonSchemaCache.add(structuredFallbackCacheKey(slot));
}

export function isJsonSchemaUnsupportedError(err: unknown): boolean {
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
