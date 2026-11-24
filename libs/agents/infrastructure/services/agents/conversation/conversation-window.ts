import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { declaredAnswerTokens } from '@libs/llm/model-invocation';
import { slotContextWindow } from '@libs/llm/slot-window';

/** The compressor's own margin for tokenizer drift (its default share). */
const MARGIN_SHARE = 0.08;

/**
 * Keeps every step of a conversation within its model's window (#2233). A
 * conversation re-sends each tool result on every step, and one PR diff read
 * through `KODUS_GET_PULL_REQUEST_DIFF` sent requests of 3.8M tokens to
 * 1M-token models. The other agents already ran with this compressor; the
 * conversation had none. The answer the call declares stays out of the
 * budget: the slot's own `maxOutputTokens`, and the thinking budget Anthropic
 * adds on top, else the conversation's own answer limit.
 */
export async function conversationCompression(params: {
    slot: NormalizedModel | undefined;
    systemPrompt: string;
    tools: readonly unknown[];
    /** The answer the conversation asks for when the slot sets none. */
    answerTokens: number;
}): Promise<CompressionPolicy> {
    const window = slotContextWindow(params.slot);
    const answer = await declaredAnswerTokens(
        params.slot,
        params.slot?.maxOutputTokens && params.slot.maxOutputTokens > 0
            ? params.slot.maxOutputTokens
            : params.answerTokens,
    );
    return new CompressionPolicy(
        new ContextWindowCompressor(window, {
            overheadTokens: estimateOverheadTokens(
                params.systemPrompt,
                params.tools,
            ),
            safetyMarginTokens: Math.ceil(window * MARGIN_SHARE) + answer,
        }),
    );
}
