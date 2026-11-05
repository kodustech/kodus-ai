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
    (DeepPartial<LanguageModelUsage> & LegacyUsageFallbacks) | null | undefined;

/** Shape of the AI SDK errors that carry the usage of a call the provider
 *  already answered (and billed) — `NoObjectGeneratedError` and its wrappers. */
interface UsageCarryingError {
    usage?: AiSdkUsageInput;
    finishReason?: string;
    cause?: unknown;
}

/**
 * Usage hanging off a FAILED AI SDK call. A structured call that dies in the
 * output parse (`AI_NoObjectGeneratedError`: schema mismatch, unparseable
 * object) was still answered by the provider and still billed — the SDK hands
 * the usage back on the error. Dropping it is spend that exists in Langfuse and
 * nowhere in the cost pipeline (the `structuredRecovery` leak).
 *
 * Returns undefined when the error carries no usage or an all-zero one, so a
 * transport failure (timeout, 429, connection reset — nothing was generated)
 * never writes a zero-token cost span.
 */
export function readAiSdkUsageFromError(
    err: unknown,
): { usage: AiSdkUsage; finishReason?: string } | undefined {
    const e = (err ?? {}) as UsageCarryingError;
    const cause = (e.cause ?? {}) as UsageCarryingError;
    const raw = e.usage ?? cause.usage;
    if (!raw) return undefined;

    const usage = readAiSdkUsage(raw);
    const billed =
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.totalTokens ?? 0);
    if (billed <= 0) return undefined;

    return { usage, finishReason: e.finishReason ?? cause.finishReason };
}

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

const USAGE_KEYS: (keyof AiSdkUsage)[] = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
];

/**
 * Running total of the usage of the steps an agent loop finished. The loop's
 * span records the usage `generateText` returns, and a loop that throws after
 * some steps (an abort, the hard timeout) returns none, so the steps the
 * provider already answered and billed would reach no cost span (#2389).
 */
export function createStepUsageTally(): {
    add(usage: AiSdkUsageInput): void;
    /** The total in the SDK's own shape, or undefined when no step reported. */
    total(): AiSdkUsageInput;
} {
    const sum: AiSdkUsage = {};
    let counted = false;
    return {
        add(usage) {
            if (!usage) return;
            const step = readAiSdkUsage(usage);
            for (const key of USAGE_KEYS) {
                const value = step[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                    sum[key] = (sum[key] ?? 0) + value;
                    counted = true;
                }
            }
        },
        total() {
            if (!counted) return undefined;
            return {
                inputTokens: sum.inputTokens,
                outputTokens: sum.outputTokens,
                totalTokens: sum.totalTokens,
                inputTokenDetails: {
                    cacheReadTokens: sum.cacheReadTokens,
                    cacheWriteTokens: sum.cacheWriteTokens,
                },
                outputTokenDetails: { reasoningTokens: sum.reasoningTokens },
            };
        },
    };
}

/**
 * The error, carrying `usage` for {@link readAiSdkUsageFromError} when it has
 * none of its own. An error that already carries the provider's usage keeps it.
 */
export function withUsageOnError(
    err: unknown,
    usage: AiSdkUsageInput,
): unknown {
    if (!usage || !err || typeof err !== 'object') return err;
    if (readAiSdkUsageFromError(err)) return err;
    try {
        Object.defineProperty(err, 'usage', {
            value: usage,
            configurable: true,
            writable: true,
            enumerable: false,
        });
    } catch {
        // A frozen error keeps its shape; the span records no usage, as before.
    }
    return err;
}
