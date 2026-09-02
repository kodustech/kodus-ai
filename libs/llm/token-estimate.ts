/**
 * Shared token estimator — the SINGLE tiktoken-backed home (Phase 5, plan 05-02).
 *
 * `estimateTextTokens` used to live in
 * `libs/agent-harness/infrastructure/compression/token-estimator.ts`. It was
 * lifted here so BOTH callers — the agent-harness compression path AND the new
 * BYOK tpm (tokens-per-minute) reservoir gate in libs/llm — share ONE tokenizer
 * (Don't-Hand-Roll). The agent-harness module now re-exports these symbols, so
 * every existing caller resolves unchanged. There is no second tokenizer.
 *
 * We count with tiktoken's `o200k_base` encoding (the GPT-4o family vocabulary).
 * It is NOT the exact tokenizer of every BYOK model, but it is a far tighter
 * bound than chars/4 across the code + JSON we send, and being model-agnostic
 * keeps this util free of per-provider coupling. `encode_ordinary` is used so
 * special-token-like sequences in diffs (e.g. `<|endoftext|>`) count as plain
 * text instead of throwing. On any failure (WASM load, encode throw) we fall
 * back to a conservative chars/token ratio so token counting never crashes.
 *
 * Why libs/llm and not libs/agent-harness: the tpm gate is enforced in
 * `byok-model-wrapper.ts` (libs/llm) and libs/llm must NOT depend on
 * libs/agent-harness. libs/agent-harness already depends on libs/llm elsewhere,
 * so re-exporting from agent-harness → libs/llm keeps the dependency arrow
 * one-directional (no import cycle).
 */
import { get_encoding, type Tiktoken } from 'tiktoken';

/**
 * Fallback ratio for when the tokenizer cannot load. DELIBERATELY conservative,
 * which is not what this comment used to claim.
 *
 * It said "dense code is closer to ~3 chars/token than 4". Measured against
 * `get_encoding('o200k_base')` on this repo's own TypeScript, that is false —
 * dense code runs about 4.2 chars/token, so the flat-4 estimates this constant
 * was written to correct land within ~5% while 3 OVER-counts by 28-40%.
 *
 * The value stays at 3 anyway, because a fallback guards a decision (does this
 * prompt fit?) where over-counting costs a needless split and under-counting
 * costs a failed run. What changes is the justification: this is a safety
 * margin, not an accurate ratio, and nobody should "correct" another estimator
 * to 3 on the strength of the old sentence.
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

/**
 * Memo for repeated measurements of the SAME text.
 *
 * Tokenizing is not free: ~15ms for a 92k-char file. The review planner walks
 * the same diffs several times — estimate, then chunk, then re-estimate per
 * chunk, then recurse — so without this, moving off a flat ratio would add
 * seconds to every review to answer a question whose input never changed.
 *
 * Bounded on both axes: at most MEMO_MAX_ENTRIES strings, and nothing above
 * MEMO_MAX_CHARS is cached at all (a huge string is both the least likely to
 * repeat and the most expensive to hold in a long-running worker). Insertion
 * order eviction — the planner's access pattern is a sweep, not a hot subset,
 * so LRU bookkeeping would cost more than it saves.
 */
const MEMO_MAX_ENTRIES = 512;
const MEMO_MAX_CHARS = 200_000;
const memo = new Map<string, number>();

function remember(text: string, tokens: number): number {
    if (text.length > MEMO_MAX_CHARS) {
        return tokens;
    }
    if (memo.size >= MEMO_MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) {
            memo.delete(oldest);
        }
    }
    memo.set(text, tokens);
    return tokens;
}

/** Token count of a single string, tokenizer-backed with a safe fallback. */
export function estimateTextTokens(text: string): number {
    if (!text) {
        return 0;
    }
    const hit = memo.get(text);
    if (hit !== undefined) {
        return hit;
    }
    const enc = getEncoder();
    if (enc) {
        try {
            return remember(text, enc.encode_ordinary(text).length);
        } catch {
            // fall through to the char estimate
        }
    }
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}
