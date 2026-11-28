/**
 * agent-harness — canonical Compressor: adapts the token-window context
 * compressor to the harness Compressor port. Closes the compression gap so a
 * long agentic run (large PR review, or a skill fetcher gathering lots of
 * context) doesn't risk context overflow. Generic across consumers — both
 * code-review and the skills fetcher plug this in via CompressionPolicy.
 *
 * Two-tier behavior (issue #1574):
 *   - SOFT: when usage crosses the compression threshold, truncate older
 *     tool-result text (recap-preserving) — the original best-effort pass.
 *   - HARD CLAMP: when the messages alone still exceed the REAL budget
 *     (window − system/tool-schema overhead − safety margin), evict oldest
 *     turns and truncate until the request provably fits. Unlike the old
 *     behavior, this NEVER returns the window unchanged while it overflows — an
 *     oversized request used to be sent verbatim and 400-ed the whole review.
 *
 * The investigation recap (allToolCalls) is not threaded yet — passes []
 * (weaker recap, still functional); a later step can wire the live tool-call
 * history.
 */
import { timeSync } from '@libs/core/infrastructure/activity/time-sync';
import type { ModelMessage } from 'ai';

import type {
    Compressor,
    CompressionResult,
} from '@libs/agent-harness/domain/contracts/compression.contract';
import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import {
    clampMessagesToBudget,
    compressMessages,
    estimateMessagesTokens,
    withoutThinkingAfterFirstEdit,
    type MessageTokenCounts,
    COMPRESSION_THRESHOLD_RATIO,
    worstCaseTokenCounts,
} from './context-compressor';

/**
 * Fraction of the window kept free by default for the model's own response plus
 * drift between our tokenizer and the provider's exact count. Overridable.
 */
export const DEFAULT_SAFETY_MARGIN_RATIO = 0.08;

export interface ContextWindowCompressorOptions {
    /**
     * Fixed per-request overhead (system prompt + tool-schema block) the
     * provider always adds on top of the messages. Excluded from the old
     * estimate — part of why the request overflowed. Defaults to 0.
     */
    overheadTokens?: number;
    /**
     * Absolute token headroom kept free (response + tokenizer drift). Defaults
     * to `DEFAULT_SAFETY_MARGIN_RATIO` of the window.
     */
    safetyMarginTokens?: number;
    /**
     * Leave the history whole until it no longer fits: no soft pass at the
     * usage threshold. For a run whose latest tool result is the thing asked
     * about (a PR diff in a chat), which the soft pass would cut to its first
     * few thousand characters while the request still fit.
     */
    onlyWhenOverBudget?: boolean;
    /**
     * Count what the tokenizer can't reach (a run too long to encode, such as
     * base64) at its worst, as the review's own limits do. The ordinary count
     * reads it at ~4 characters a token and let a dense tool result through
     * at a third of its size.
     */
    countAtWorstCase?: boolean;
}

/** Sizes of a window for the slow-count log: serialized characters. */
function messageSizes(
    messages: readonly ModelMessage[],
    worstCase: boolean,
): Record<string, unknown> {
    let chars = 0;
    let largestChars = 0;
    let largestRole = '';
    for (const m of messages) {
        let size: number;
        try {
            size =
                typeof m.content === 'string'
                    ? m.content.length
                    : (JSON.stringify(m.content)?.length ?? 0);
        } catch {
            size = 0;
        }
        chars += size;
        if (size > largestChars) {
            largestChars = size;
            largestRole = m.role;
        }
    }
    return {
        messages: messages.length,
        chars,
        largestChars,
        largestRole,
        worstCase,
    };
}

export class ContextWindowCompressor implements Compressor {
    private readonly overheadTokens: number;
    /** Token counts of this run's messages (see MessageTokenCounts). */
    private readonly tokenCounts: MessageTokenCounts;
    private readonly safetyMarginTokens: number;
    private readonly onlyWhenOverBudget: boolean;
    private readonly countAtWorstCase: boolean;

    constructor(
        private readonly contextWindowTokens: number,
        options: ContextWindowCompressorOptions = {},
    ) {
        this.overheadTokens = Math.max(0, options.overheadTokens ?? 0);
        this.tokenCounts = options.countAtWorstCase
            ? worstCaseTokenCounts()
            : new Map();
        this.onlyWhenOverBudget = options.onlyWhenOverBudget === true;
        this.countAtWorstCase = options.countAtWorstCase === true;
        this.safetyMarginTokens = Math.max(
            0,
            options.safetyMarginTokens ??
                Math.ceil(contextWindowTokens * DEFAULT_SAFETY_MARGIN_RATIO),
        );
    }

    maybeCompress(messages: readonly AgentMessage[]): CompressionResult | null {
        if (!this.contextWindowTokens || this.contextWindowTokens <= 0) {
            return null;
        }
        const modelMsgs: ModelMessage[] = messages.map(
            (m) => ({ role: m.role, content: m.content }) as ModelMessage,
        );

        // Real budget available to the MESSAGES themselves: the window minus the
        // fixed overhead the provider re-adds every request and a safety margin.
        const budget = Math.max(
            0,
            this.contextWindowTokens -
                this.overheadTokens -
                this.safetyMarginTokens,
        );

        // Tokenizes the whole history every step: the 2026-11-19 stall in
        // tiktoken was here. A slow count is logged with its job.
        const current = timeSync(
            'context compressor token count',
            () => estimateMessagesTokens(modelMsgs, this.tokenCounts),
            // Only built for a slow count: tells a huge head (one message)
            // from a long history, which need different fixes.
            () => messageSizes(modelMsgs, this.countAtWorstCase),
        );
        const usage = current + this.overheadTokens;

        // Soft trigger: total usage crosses the compression threshold. Hard
        // trigger: the messages alone already exceed the real budget.
        const softTrigger =
            !this.onlyWhenOverBudget &&
            usage > this.contextWindowTokens * COMPRESSION_THRESHOLD_RATIO;
        const overBudget = current > budget;
        if (!softTrigger && !overBudget) {
            return null;
        }

        // 1. Soft pass: truncate older tool-result text (recap-preserving).
        let compressed = compressMessages(modelMsgs, []);
        let after = estimateMessagesTokens(compressed, this.tokenCounts);

        // 2. Hard clamp: guarantee the messages fit the real budget. This is the
        //    invariant the old "return null on no savings" path violated — an
        //    oversized window was sent verbatim and overflowed the provider.
        if (after > budget) {
            compressed = clampMessagesToBudget(
                compressed,
                budget,
                this.tokenCounts,
            );
            after = estimateMessagesTokens(compressed, this.tokenCounts);
        }

        // Nothing to gain AND we were never over budget → leave the window as-is.
        if (after >= current && !overBudget) {
            return null;
        }

        // Thinking blocks after the first edit no longer match their signed
        // prefix; Anthropic rejects the whole request if they are replayed.
        compressed = withoutThinkingAfterFirstEdit(modelMsgs, compressed);

        return {
            // Return content as-is: the truncation/eviction above already
            // preserved the parts structure. Stringifying here would re-flatten
            // `tool` turns and crash the SDK on `content.filter` when this
            // window is handed back to generateText.
            messages: compressed.map((m) => ({
                role: m.role as AgentMessage['role'],
                content: m.content as AgentMessage['content'],
            })),
            beforeTokens: current,
            afterTokens: after,
        };
    }
}
