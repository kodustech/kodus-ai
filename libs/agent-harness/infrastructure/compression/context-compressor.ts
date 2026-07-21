/**
 * Context compression for the agent loop.
 *
 * When the agent loop runs many tool calls (readFile, grep, checkTypes, ...),
 * each tool result is appended to the LLM message history. With parallel
 * tool calling, a single assistant step can emit 20+ tool results, so the
 * history can easily reach hundreds of thousands of tokens and blow the
 * model's context window.
 *
 * Strategy (size-based, not count-based):
 *   1. Always preserve the system prompt and the first user message — the
 *      user message contains the <Diffs> block, which is non-negotiable for
 *      the review to produce line-accurate findings.
 *   2. In the tail (everything after the preserved head), aggressively
 *      truncate tool-result content:
 *        - "Recent" tool results (the last N in the tail) get a larger cap
 *          because the agent is actively reasoning about them.
 *        - "Older" tool results get an aggressive cap, preserving only a
 *          preview so the agent knows it already did the call.
 *   3. When older tool results are truncated, inject a summary system
 *      message built from `allToolCalls` — our own tracking array that is
 *      kept intact outside the LLM message history. This gives the agent a
 *      structured recap of "what was done" so it doesn't repeat tool calls.
 *
 * `allToolCalls` is used by downstream passes (second chance, coverage
 * recovery, synthesis rescue), so compression never affects the quality of
 * the final review — it only affects what the main agent loop sees in its
 * next LLM call.
 */

import { estimateValueTokens } from './token-estimator';

/** Trigger compression when context usage crosses this fraction of the window. */
export const COMPRESSION_THRESHOLD_RATIO = 0.7;

/**
 * How many most-recent tail messages are considered "recent" and get the
 * larger per-tool-result cap. Counted in raw message slots (parallel tool
 * results in a single message all share the same slot).
 */
const RECENT_TAIL_MESSAGES = 4;

/** Max characters per tool-result text when inside a recent message. */
const RECENT_MAX_CHARS_PER_RESULT = 3_000;

/** Max characters per tool-result text when inside an older message. */
const OLDER_MAX_CHARS_PER_RESULT = 400;

/** Max characters per entry in the investigation summary. */
const SUMMARY_MAX_CHARS_PER_ENTRY = 200;

/**
 * Aggressive per-tool-result cap used by the hard clamp (phase 1). Applied to
 * EVERY tool result (recent included), unlike the soft pass which spares the
 * recent tail. Small enough to reclaim the bulk of an overflowing window while
 * still leaving the agent a usable preview of each call.
 */
const HARD_CLAMP_MAX_CHARS_PER_RESULT = 500;

export interface ModelMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: unknown;
    [key: string]: unknown;
}

interface ToolCallRecord {
    tool: string;
    toolName?: string;
    args: Record<string, unknown>;
    result?: string;
}

/**
 * Estimates the token count of a message array with a real tokenizer
 * (`token-estimator`), serializing each message so the structured `tool` /
 * `tool-call` parts are counted the way the provider sees them on the wire.
 * Replaces the old flat 4-chars/token estimate that under-counted dense code by
 * ~1.6× and let the compressor believe it was under budget while the request
 * already overflowed (issue #1574).
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateValueTokens(msg);
    }
    return total;
}

/**
 * Decides whether the current message history should be compressed.
 */
export function shouldCompress(
    messages: ModelMessage[],
    contextWindowTokens: number,
    thresholdRatio: number = COMPRESSION_THRESHOLD_RATIO,
): { should: boolean; currentTokens: number; thresholdTokens: number } {
    const currentTokens = estimateMessagesTokens(messages);
    const thresholdTokens = Math.floor(contextWindowTokens * thresholdRatio);
    return {
        should: currentTokens > thresholdTokens,
        currentTokens,
        thresholdTokens,
    };
}

/**
 * Build a concise textual recap of the investigation from our own tracking
 * array. Injected as a system message when compression drops older content.
 */
function buildInvestigationSummary(allToolCalls: ToolCallRecord[]): string {
    if (!allToolCalls || allToolCalls.length === 0) {
        return '';
    }

    const lines: string[] = [
        'Previously investigated (older tool results truncated to save context):',
    ];

    for (const tc of allToolCalls) {
        const name = tc.toolName || tc.tool || 'unknown';
        const args = tc.args || {};
        const argSummary = summarizeArgs(args);
        let entry = `- ${name}(${argSummary})`;

        if (tc.result) {
            const preview = String(tc.result)
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, SUMMARY_MAX_CHARS_PER_ENTRY);
            if (preview) {
                entry += ` → ${preview}${tc.result.length > SUMMARY_MAX_CHARS_PER_ENTRY ? '…' : ''}`;
            }
        }

        lines.push(entry);
    }

    lines.push('');
    lines.push(
        'Use this recap to avoid redundant tool calls. Continue your investigation from the most recent tool results shown below.',
    );

    return lines.join('\n');
}

function summarizeArgs(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
        if (v === undefined || v === null) continue;
        const val =
            typeof v === 'string'
                ? v.length > 80
                    ? `${v.slice(0, 80)}…`
                    : v
                : JSON.stringify(v).slice(0, 80);
        parts.push(`${k}=${val}`);
    }
    return parts.join(', ');
}

/**
 * Truncates a single text field to `maxChars`, appending a marker.
 * Only truncates if the input exceeds the cap — otherwise returns as-is.
 */
function truncateText(text: string, maxChars: number): string {
    if (typeof text !== 'string' || text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '…[truncated]';
}

/**
 * Truncates the content of a `tool` message. The content can be:
 *   - a string
 *   - an array of tool-result parts (Vercel AI SDK v5 structure)
 *
 * Each tool-result part may have its payload in `output`, `result`, `text`,
 * or `content` — we handle all variants defensively.
 */
function truncateToolMessage(
    msg: ModelMessage,
    maxChars: number,
): { msg: ModelMessage; truncated: boolean } {
    const content = msg.content;
    let truncated = false;

    if (typeof content === 'string') {
        if (content.length > maxChars) {
            truncated = true;
            return {
                msg: { ...msg, content: truncateText(content, maxChars) },
                truncated,
            };
        }
        return { msg, truncated };
    }

    if (Array.isArray(content)) {
        const newContent = content.map((part: any) => {
            if (!part || typeof part !== 'object') return part;

            const next = { ...part };
            for (const field of ['text', 'output', 'result', 'content']) {
                const v = next[field];
                if (typeof v === 'string' && v.length > maxChars) {
                    next[field] = truncateText(v, maxChars);
                    truncated = true;
                } else if (v && typeof v === 'object') {
                    // Nested structured output (e.g. { type: 'text', value: '...' })
                    try {
                        const serialized = JSON.stringify(v);
                        if (serialized.length > maxChars) {
                            next[field] = truncateText(serialized, maxChars);
                            truncated = true;
                        }
                    } catch {
                        // Ignore non-serializable nested content
                    }
                }
            }
            return next;
        });

        return { msg: { ...msg, content: newContent }, truncated };
    }

    return { msg, truncated };
}

/**
 * Compresses the message history by:
 *   1. Preserving the head (all leading `system` messages + the first `user`
 *      message that contains <Diffs>).
 *   2. In the tail, keeping the last N messages with a larger per-result cap
 *      and older ones with an aggressive per-result cap.
 *   3. Injecting a summary system message before the tail if any older
 *      content was actually truncated — the summary is built from
 *      `allToolCalls`, our own tracking array outside the LLM history.
 *
 * Unlike the previous count-based strategy, this works even when parallel
 * tool calling packs 20+ results into a single `tool` message slot.
 */
export function compressMessages(
    messages: ModelMessage[],
    allToolCalls: ToolCallRecord[],
): ModelMessage[] {
    if (!messages || messages.length === 0) {
        return messages;
    }

    // Split head (leading system messages + first user message)
    const head: ModelMessage[] = [];
    let idx = 0;
    while (idx < messages.length && messages[idx].role === 'system') {
        head.push(messages[idx]);
        idx++;
    }
    if (idx < messages.length && messages[idx].role === 'user') {
        head.push(messages[idx]);
        idx++;
    }

    const tail = messages.slice(idx);
    if (tail.length === 0) {
        return messages;
    }

    // Determine which tail messages are "recent" (larger cap) vs "older".
    const recentStart = Math.max(0, tail.length - RECENT_TAIL_MESSAGES);

    let anyTruncated = false;
    const compressedTail: ModelMessage[] = tail.map((msg, i) => {
        if (msg.role !== 'tool') return msg;
        const maxChars =
            i >= recentStart
                ? RECENT_MAX_CHARS_PER_RESULT
                : OLDER_MAX_CHARS_PER_RESULT;
        const { msg: newMsg, truncated } = truncateToolMessage(msg, maxChars);
        if (truncated) anyTruncated = true;
        return newMsg;
    });

    // Only inject the summary when we actually truncated older content —
    // avoids polluting the prompt with a recap when nothing changed.
    //
    // IMPORTANT: the recap MUST be a `user` message, not `system`. Gemini only
    // accepts `system` at position 0 of the conversation ("system messages
    // are only supported at the beginning of the conversation"), and we
    // already have the agent's own system prompt at head[0]. OpenAI and
    // Claude tolerate mid-conversation system messages, but Gemini does not,
    // so we use a `user` role with an explicit prefix to preserve semantics
    // across providers.
    if (anyTruncated && allToolCalls && allToolCalls.length > 0) {
        const summary = buildInvestigationSummary(allToolCalls);
        if (summary) {
            const recapMsg: ModelMessage = {
                role: 'user',
                content: `[investigation recap]\n${summary}`,
            };
            return [...head, recapMsg, ...compressedTail];
        }
    }

    return [...head, ...compressedTail];
}

/**
 * Splits the head (leading `system` messages + the first `user` message, which
 * carries the non-negotiable <Diffs> block) from the rest of the window.
 */
function splitHead(messages: ModelMessage[]): {
    head: ModelMessage[];
    rest: ModelMessage[];
} {
    const head: ModelMessage[] = [];
    let idx = 0;
    while (idx < messages.length && messages[idx].role === 'system') {
        head.push(messages[idx]);
        idx++;
    }
    if (idx < messages.length && messages[idx].role === 'user') {
        head.push(messages[idx]);
        idx++;
    }
    return { head, rest: messages.slice(idx) };
}

/**
 * Groups a message sequence into "rounds": each non-`tool` message (an
 * assistant turn, or a steering user note) plus the `tool` messages that
 * immediately follow it (its results). Evicting whole rounds keeps the window
 * structurally valid for the AI SDK — a `tool` result never survives without
 * the assistant tool-call it answers, so no provider sees an orphaned result.
 */
function groupRounds(messages: ModelMessage[]): ModelMessage[][] {
    const rounds: ModelMessage[][] = [];
    let current: ModelMessage[] | null = null;
    for (const m of messages) {
        if (m.role === 'tool' && current) {
            current.push(m);
        } else {
            if (current) {
                rounds.push(current);
            }
            current = [m];
        }
    }
    if (current) {
        rounds.push(current);
    }
    return rounds;
}

/**
 * Evicts the OLDEST rounds from the middle of the window, keeping the head and
 * as many of the most-recent rounds as fit under `budgetTokens`. Always keeps
 * at least the single newest round (phase 3 truncates it if even that
 * overflows). Structure-preserving via {@link groupRounds}.
 */
function evictOldestRounds(
    messages: ModelMessage[],
    budgetTokens: number,
): ModelMessage[] {
    const { head, rest } = splitHead(messages);
    const rounds = groupRounds(rest);
    if (rounds.length === 0) {
        return messages;
    }

    let running = estimateMessagesTokens(head);
    const keptReversed: ModelMessage[][] = [];
    for (let i = rounds.length - 1; i >= 0; i--) {
        const rtok = estimateMessagesTokens(rounds[i]);
        if (keptReversed.length === 0 || running + rtok <= budgetTokens) {
            keptReversed.push(rounds[i]);
            running += rtok;
        } else {
            // Rounds only get older (and never smaller in aggregate) as we walk
            // backwards, so once one doesn't fit, neither will the rest.
            break;
        }
    }
    return [...head, ...keptReversed.reverse().flat()];
}

/**
 * Last-resort clamp: shrink every message's text content with a geometrically
 * decreasing cap until the window estimates under `budgetTokens`. Truncates
 * only text/output/result/content fields (never tool-call `input`/`args`), so
 * assistant tool-call parts stay structurally intact. Bounded iteration count —
 * returns the best effort if a pathological window can't be reduced further.
 */
function hardTruncateToFit(
    messages: ModelMessage[],
    budgetTokens: number,
): ModelMessage[] {
    let cap = HARD_CLAMP_MAX_CHARS_PER_RESULT;
    let work = messages;
    for (let i = 0; i < 12; i++) {
        work = messages.map(
            (m) => truncateToolMessage(m, cap).msg,
        );
        if (estimateMessagesTokens(work) <= budgetTokens) {
            return work;
        }
        if (cap <= 80) {
            break;
        }
        cap = Math.max(80, Math.floor(cap / 2));
    }
    return work;
}

/**
 * Hard per-request clamp. Guarantees the returned window estimates at or below
 * `budgetTokens` (the model window minus fixed system + tool-schema overhead
 * and a safety margin) whenever possible, so the agent NEVER emits a request
 * larger than the context window even when the soft pass can't reduce enough.
 *
 * Order of operations (least → most destructive), each structure-preserving so
 * the AI SDK never sees an orphaned tool result:
 *   1. Aggressively truncate EVERY tool-result text to a tiny cap.
 *   2. Evict whole oldest rounds (an assistant turn + its tool results),
 *      keeping the head (diff) and the most-recent rounds.
 *   3. Last resort: hard-truncate the remaining message contents until it fits.
 */
export function clampMessagesToBudget(
    messages: ModelMessage[],
    budgetTokens: number,
): ModelMessage[] {
    if (!messages || messages.length === 0 || budgetTokens <= 0) {
        return messages;
    }
    if (estimateMessagesTokens(messages) <= budgetTokens) {
        return messages;
    }

    // Phase 1: aggressive tool-result truncation across the whole window.
    let work = messages.map((m) =>
        m.role === 'tool'
            ? truncateToolMessage(m, HARD_CLAMP_MAX_CHARS_PER_RESULT).msg
            : m,
    );
    if (estimateMessagesTokens(work) <= budgetTokens) {
        return work;
    }

    // Phase 2: evict oldest rounds, preserving head + most-recent rounds.
    work = evictOldestRounds(work, budgetTokens);
    if (estimateMessagesTokens(work) <= budgetTokens) {
        return work;
    }

    // Phase 3: shrink every remaining message's content until the window fits.
    return hardTruncateToFit(work, budgetTokens);
}
