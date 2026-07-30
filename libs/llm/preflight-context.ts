/**
 * Defense-in-depth context-window preflight — domain-agnostic.
 *
 * Before a generateText call, estimate prompt tokens and refuse to proceed if
 * they exceed the configured model's context window. Without this, the Vercel
 * AI SDK would retry the call up to `maxRetries` times against an undersized
 * context — burning the whole timeout budget while each attempt fails the same.
 */
import { AgentPromptTooLargeError } from './errors';

/**
 * Rough char-per-token ratio used by the preflight estimator. Matches
 * the same constant used by the base agent provider's prompt sizing.
 */
const PREFLIGHT_CHARS_PER_TOKEN = 4;
/**
 * Fraction of the context window held back for the model's reasoning
 * + tool-call output. The agent emits structured findings JSON and may
 * also produce thinking tokens; ~15% gives both room without being
 * wasteful. Clamped to at least 2_048 tokens because below that, even
 * a small `submitResult` payload can't fit.
 */
const PREFLIGHT_OUTPUT_RESERVE_RATIO = 0.15;
const PREFLIGHT_MIN_OUTPUT_RESERVE_TOKENS = 2_048;

/**
 * Pure function (no awaits, no I/O). Exported so it can be unit-tested.
 * When contextWindowTokens is undefined we cannot enforce — callers that
 * already resolve it will always pass a number.
 */
export function assertPromptFitsInContext(params: {
    systemPrompt: string;
    userPrompt: string;
    contextWindowTokens: number | undefined;
    modelName: string;
}): void {
    if (!params.contextWindowTokens || params.contextWindowTokens <= 0) {
        return;
    }
    const promptChars =
        (params.systemPrompt?.length ?? 0) + (params.userPrompt?.length ?? 0);
    const estimatedTokens = Math.ceil(promptChars / PREFLIGHT_CHARS_PER_TOKEN);
    const outputReserve = Math.max(
        PREFLIGHT_MIN_OUTPUT_RESERVE_TOKENS,
        Math.floor(params.contextWindowTokens * PREFLIGHT_OUTPUT_RESERVE_RATIO),
    );
    if (estimatedTokens + outputReserve > params.contextWindowTokens) {
        throw new AgentPromptTooLargeError({
            estimatedTokens,
            contextWindowTokens: params.contextWindowTokens,
            modelName: params.modelName,
        });
    }
}
