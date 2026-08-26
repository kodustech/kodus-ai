import type { DeepPartial, LanguageModelUsage } from 'ai';

/**
 * THE single reader that maps the Vercel AI SDK's usage onto the token fields the
 * cost/telemetry pipeline consumes. Both prod call paths go through here — the
 * agent harness (`ai-sdk-agent-runner`) and the one-shot wrapper
 * (`observability.service.runAiSdkLLMInSpan`) — so a usage field can never again
 * be read in one path and dropped in the other (the duplication that let cache
 * tokens silently record 0; see PR #1616 and its cache-write follow-up).
 *
 * Provider-agnostic by construction: the SDK (`ai@7`) normalizes EVERY provider
 * into one shape before we see it —
 *   inputTokens (total) = inputTokenDetails.{noCacheTokens + cacheReadTokens + cacheWriteTokens}
 *   outputTokenDetails.{textTokens, reasoningTokens}
 * so reading the nested details works for all providers. anthropic/bedrock
 * populate `cacheWriteTokens` (cache creation); openai/openai-compatible/google
 * leave it undefined. `inputTokens` INCLUDING the cached portions is what the
 * cost calculator relies on when it subtracts cacheRead + cacheWrite from the
 * full-price pool (model-cost-calculator).
 */
export interface AiSdkUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

/**
 * ai@6 flat field names, kept as fallbacks for vendor shims / mixed-version
 * responses. They do NOT exist on the ai@7 `LanguageModelUsage` type, so they
 * are declared here explicitly rather than reached through `any`.
 */
interface LegacyUsageFallbacks {
    cachedInputTokens?: number;
    reasoningTokens?: number;
    cacheCreationInputTokens?: number;
}

// DeepPartial (not Partial): the SDK's `inputTokenDetails`/`outputTokenDetails`
// are nested objects with required keys, so a shallow Partial would still force
// every nested field. Vendor shims and a just-usage fragment may omit some, and
// the reader chains defensively with `?.` — so accept any subset. A real ai@7
// `LanguageModelUsage` is still assignable (more specific → deep-partial).
export type AiSdkUsageInput =
    | (DeepPartial<LanguageModelUsage> & LegacyUsageFallbacks)
    | null
    | undefined;

/** Map an AI SDK usage object onto {@link AiSdkUsage}. Null/undefined-safe. */
export function readAiSdkUsage(usage: AiSdkUsageInput): AiSdkUsage {
    return {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        reasoningTokens:
            usage?.outputTokenDetails?.reasoningTokens ??
            usage?.reasoningTokens,
        cacheReadTokens:
            usage?.inputTokenDetails?.cacheReadTokens ??
            usage?.cachedInputTokens,
        cacheWriteTokens:
            usage?.inputTokenDetails?.cacheWriteTokens ??
            usage?.cacheCreationInputTokens,
    };
}
