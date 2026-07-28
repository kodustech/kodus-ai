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
    COMPRESSION_THRESHOLD_RATIO,
} from './context-compressor';

/**
 * Fraction of the window kept free by default for the model's own response plus
 * drift between our tokenizer and the provider's exact count. Overridable.
 */
const DEFAULT_SAFETY_MARGIN_RATIO = 0.08;

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
}

export class ContextWindowCompressor implements Compressor {
    private readonly overheadTokens: number;
    private readonly safetyMarginTokens: number;

    constructor(
        private readonly contextWindowTokens: number,
        options: ContextWindowCompressorOptions = {},
    ) {
        this.overheadTokens = Math.max(0, options.overheadTokens ?? 0);
        this.safetyMarginTokens = Math.max(
            0,
            options.safetyMarginTokens ??
                Math.ceil(contextWindowTokens * DEFAULT_SAFETY_MARGIN_RATIO),
        );
    }

    maybeCompress(
        messages: readonly AgentMessage[],
    ): CompressionResult | null {
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

        const current = estimateMessagesTokens(modelMsgs);
        const usage = current + this.overheadTokens;

        // Soft trigger: total usage crosses the compression threshold. Hard
        // trigger: the messages alone already exceed the real budget.
        const softTrigger =
            usage > this.contextWindowTokens * COMPRESSION_THRESHOLD_RATIO;
        const overBudget = current > budget;
        if (!softTrigger && !overBudget) {
            return null;
        }

        // 1. Soft pass: truncate older tool-result text (recap-preserving).
        let compressed = compressMessages(modelMsgs, []);
        let after = estimateMessagesTokens(compressed);

        // 2. Hard clamp: guarantee the messages fit the real budget. This is the
        //    invariant the old "return null on no savings" path violated — an
        //    oversized window was sent verbatim and overflowed the provider.
        if (after > budget) {
            compressed = clampMessagesToBudget(compressed, budget);
            after = estimateMessagesTokens(compressed);
        }

        // Nothing to gain AND we were never over budget → leave the window as-is.
        if (after >= current && !overBudget) {
            return null;
        }

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
