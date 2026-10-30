/**
 * agent-harness — real-tokenizer token counting for the compression path.
 *
 * The compressor used to estimate tokens at a flat 4 chars/token. Dense code
 * (JS/Vue + i18n JSON) tokenizes closer to ~2.6–2.8 chars/token, so that
 * estimate under-counted the real request by ~1.6× — the exact factor behind
 * the mid-loop context-window overflow (issue #1574): the compressor believed
 * it was under budget while the provider already saw the request over the
 * window (`requested: 421869` against a `262144` window ≈ 1.6×).
 *
 * `estimateTextTokens` (+ its tiktoken encoder + `FALLBACK_CHARS_PER_TOKEN`)
 * was LIFTED to `@libs/llm/token-estimate` (Phase 5, plan 05-02) so the BYOK
 * tpm reservoir gate shares the SAME tokenizer — one source of truth, no second
 * tiktoken encoder. This module re-exports it so every existing caller resolves
 * unchanged, and keeps the message/value/overhead helpers that build on it.
 */
import {
    estimateTextTokens,
    FALLBACK_CHARS_PER_TOKEN,
} from '@libs/llm/token-estimate';

// Re-export the lifted primitives so existing agent-harness callers (and the
// spec) keep importing them from this module.
export { estimateTextTokens, FALLBACK_CHARS_PER_TOKEN };

/**
 * Token count of a message-like value. Objects are JSON-serialized first so the
 * structured `tool` / `tool-call` parts are counted the same way the provider
 * sees them on the wire.
 */
export function estimateValueTokens(value: unknown): number {
    if (value == null) {
        return 0;
    }
    if (typeof value === 'string') {
        return estimateTextTokens(value);
    }
    let serialized: string;
    try {
        serialized = JSON.stringify(value);
    } catch {
        serialized = String(value);
    }
    return estimateTextTokens(serialized);
}

/**
 * Fixed per-request overhead the provider adds on top of the conversation
 * messages: the system prompt plus the tool-schema block the AI SDK re-sends on
 * every step. Counting this (the old estimator ignored it) is what lets the
 * compressor reserve a real budget for the messages instead of over-committing
 * the window (issue #1574).
 */
export function estimateOverheadTokens(
    systemPrompt: string | undefined,
    toolDefs: readonly unknown[],
): number {
    let total = estimateTextTokens(systemPrompt ?? '');
    for (const def of toolDefs) {
        total += estimateValueTokens(def);
    }
    return total;
}
