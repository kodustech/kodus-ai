/**
 * Defense-in-depth context-window preflight — domain-agnostic.
 *
 * Before a generateText call, estimate prompt tokens and refuse to proceed if
 * they exceed the configured model's context window. Without this, the Vercel
 * AI SDK would retry the call up to `maxRetries` times against an undersized
 * context — burning the whole timeout budget while each attempt fails the same.
 */
import { AgentPromptTooLargeError } from './errors';
import { estimateTextTokens } from './token-estimate';

// The preflight used a flat chars/4 ratio while holding the full prompt TEXT in
// its hands — it counted `.length` and threw the strings away. The real
// tokenizer is right here in the same lib, so the guard that decides whether a
// run is even attempted now measures instead of approximating.
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
    const estimatedTokens =
        estimateTextTokens(params.systemPrompt ?? '') +
        estimateTextTokens(params.userPrompt ?? '');
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
