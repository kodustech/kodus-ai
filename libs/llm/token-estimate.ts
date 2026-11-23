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
 * MEMO_MAX_CHARS is cached here (a huge string is the most expensive to hold
 * in a long-running worker; the few that repeat go to the large memo below,
 * which is bounded by total characters instead). Insertion
 * order eviction — the planner's access pattern is a sweep, not a hot subset,
 * so LRU bookkeeping would cost more than it saves.
 */
const MEMO_MAX_ENTRIES = 512;
export const MEMO_MAX_CHARS = 200_000;
const memo = new Map<string, number>();

/**
 * Memo for the few HUGE texts that do repeat: the head message of an agent
 * run (diff plus graph context), which the context compressor re-measures
 * on every step and several more times when it trims rounds.
 *
 * Kept out of the main memo, it was tokenized in full on every count. On
 * 2026-11-23 a 2,353,179-char graph context cost 1.8s per count and held a
 * worker's event loop 9.2s in one compression pass (seen as a 9.4s "slow
 * query" whose reply waited on the loop). This memo makes every count after
 * the first a lookup.
 *
 * Bounded by entries and by total characters, so a long-running worker
 * holds at most LARGE_MEMO_MAX_TOTAL_CHARS (~16MB of UTF-16) here; the
 * least recently used text goes first, since one run reuses one head.
 * A text above LARGE_MEMO_MAX_TOTAL_CHARS on its own is never cached.
 */
const LARGE_MEMO_MAX_ENTRIES = 8;
const LARGE_MEMO_MAX_TOTAL_CHARS = 8_000_000;
const largeMemo = new Map<string, number>();
let largeMemoChars = 0;

function rememberLarge(text: string, tokens: number): number {
    if (text.length > LARGE_MEMO_MAX_TOTAL_CHARS) {
        return tokens;
    }
    while (
        largeMemo.size > 0 &&
        (largeMemo.size >= LARGE_MEMO_MAX_ENTRIES ||
            largeMemoChars + text.length > LARGE_MEMO_MAX_TOTAL_CHARS)
    ) {
        const oldest = largeMemo.keys().next().value as string;
        largeMemo.delete(oldest);
        largeMemoChars -= oldest.length;
    }
    largeMemo.set(text, tokens);
    largeMemoChars += text.length;
    return tokens;
}

function recallLarge(text: string): number | undefined {
    const hit = largeMemo.get(text);
    if (hit !== undefined) {
        // Re-insert: Map order is the LRU order.
        largeMemo.delete(text);
        largeMemo.set(text, hit);
    }
    return hit;
}

/** @internal Exported for testing purposes only */
export function _resetTokenEstimateMemo(): void {
    memo.clear();
    largeMemo.clear();
    largeMemoChars = 0;
}

function remember(text: string, tokens: number): number {
    if (text.length > MEMO_MAX_CHARS) {
        return rememberLarge(text, tokens);
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

/**
 * Longest run without whitespace that tiktoken is asked to encode.
 *
 * tiktoken's BPE is quadratic in the length of one pre-token piece, and a
 * piece never spans whitespace. A long run with no separator (a repeated
 * character, a hex blob, a minified line pasted by a grep) took 0.9s at 40KB
 * locally and froze a worker for 88s in prod (2026-11-19, inside the context
 * compressor). Longer runs are counted with the conservative char ratio
 * instead: a code token is never this long, so ordinary text is counted
 * exactly as before.
 */
export const MAX_ENCODED_RUN_CHARS = 1_000;

function isWhitespace(code: number): boolean {
    // Unicode White_Space, the set tiktoken's `\s` splits on: a character
    // missing here would restart a whitespace run at every step, so a run
    // alternating it with a space would never reach the limit while
    // tiktoken still saw one quadratic piece.
    return (
        (code >= 9 && code <= 13) ||
        code === 32 ||
        code === 0x85 ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000
    );
}

/**
 * tiktoken count, except that any run of more than MAX_ENCODED_RUN_CHARS
 * characters of one kind (whitespace, or anything but whitespace) is
 * estimated instead: tiktoken is quadratic on both, since a whitespace run is
 * one pre-token piece too (80k spaces took 3.8s). A whitespace run counts by
 * the fallback ratio (conservative: tiktoken packs many spaces per token).
 * In any other run, ASCII characters count by the fallback ratio and every
 * other character as one token (CJK and other scripts written without spaces
 * run about 1-1.5 characters per token, so 3 would under-count them). One
 * linear pass over the text; no regex (a `\S{n,}` scan would itself be
 * O(n·k)).
 */
function countTokens(enc: Tiktoken, text: string): number {
    if (text.length <= MAX_ENCODED_RUN_CHARS) {
        return enc.encode_ordinary(text).length;
    }
    let tokens = 0;
    let segmentStart = 0;
    let runStart = 0;
    let runIsWhitespace = isWhitespace(text.charCodeAt(0));
    let longRuns = false;
    // Non-ASCII code units in the current (non-whitespace) run.
    let runNonAscii = 0;
    const flushRun = (runEnd: number) => {
        const length = runEnd - runStart;
        if (length <= MAX_ENCODED_RUN_CHARS) return;
        longRuns = true;
        if (runStart > segmentStart) {
            tokens += enc.encode_ordinary(
                text.slice(segmentStart, runStart),
            ).length;
        }
        tokens += runIsWhitespace
            ? Math.ceil(length / FALLBACK_CHARS_PER_TOKEN)
            : Math.ceil((length - runNonAscii) / FALLBACK_CHARS_PER_TOKEN) +
              runNonAscii;
        segmentStart = runEnd;
    };
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const whitespace = isWhitespace(code);
        if (whitespace !== runIsWhitespace) {
            flushRun(i);
            runStart = i;
            runIsWhitespace = whitespace;
            runNonAscii = 0;
        }
        if (!whitespace && code > 0x7f) runNonAscii++;
    }
    flushRun(text.length);
    if (!longRuns) return enc.encode_ordinary(text).length;
    if (segmentStart < text.length) {
        tokens += enc.encode_ordinary(text.slice(segmentStart)).length;
    }
    return tokens;
}

/** Token count of a single string; transient slices can bypass the shared memo. */
export function estimateTextTokens(
    text: string,
    options?: { cache?: boolean },
): number {
    if (!text) {
        return 0;
    }
    const useMemo = options?.cache !== false;
    let hit: number | undefined;
    if (useMemo) {
        hit = text.length > MEMO_MAX_CHARS ? recallLarge(text) : memo.get(text);
    }
    if (hit !== undefined) {
        return hit;
    }
    const enc = getEncoder();
    if (enc) {
        try {
            const tokens = countTokens(enc, text);
            return useMemo ? remember(text, tokens) : tokens;
        } catch {
            // fall through to the char estimate
        }
    }
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}
