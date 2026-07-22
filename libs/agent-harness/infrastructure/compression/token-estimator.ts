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
 * We count with tiktoken's `o200k_base` encoding (the GPT-4o family
 * vocabulary). It is NOT the exact tokenizer of every BYOK model, but it is a
 * far tighter bound than chars/4 across the code + JSON we send, and being
 * model-agnostic keeps this harness free of per-provider coupling. `encode_
 * ordinary` is used so special-token-like sequences in diffs (e.g.
 * `<|endoftext|>`) count as plain text instead of throwing. On any failure
 * (WASM load, encode throw) we fall back to a conservative chars/token ratio so
 * token counting never crashes the agent loop.
 */
import { get_encoding, type Tiktoken } from 'tiktoken';

/**
 * Conservative fallback ratio when the tokenizer is unavailable. Dense code is
 * closer to ~3 chars/token than 4, so the fallback still doesn't systematically
 * under-count the way the old flat-4 estimate did.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3;

let encoder: Tiktoken | null = null;
let encoderFailed = false;

function getEncoder(): Tiktoken | null {
    if (encoder) {
        return encoder;
    }
    if (encoderFailed) {
        return null;
    }
    try {
        encoder = get_encoding('o200k_base');
        return encoder;
    } catch {
        // WASM unavailable / load failure — never retry, use the char fallback.
        encoderFailed = true;
        return null;
    }
}

/** Token count of a single string, tokenizer-backed with a safe fallback. */
export function estimateTextTokens(text: string): number {
    if (!text) {
        return 0;
    }
    const enc = getEncoder();
    if (enc) {
        try {
            return enc.encode_ordinary(text).length;
        } catch {
            // fall through to the char estimate
        }
    }
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

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
