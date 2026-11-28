import {
    ContextWindowCompressor,
    DEFAULT_SAFETY_MARGIN_RATIO,
} from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { declaredAnswerTokens } from '@libs/llm/model-invocation';
import { slotContextWindow, slotInputRoom } from '@libs/llm/slot-window';

/** The answer a conversation reserves when the slot sets none. */
export const CONVERSATION_ANSWER_TOKENS = 20_000;

/**
 * The answer a conversation reserves when the slot sets no maxOutputTokens:
 * 20k, but never more than a quarter of the smallest window the call may run
 * on (the slot or its fallback). A 24k slot reserved 20k and left 4k for a
 * prompt whose tool schemas alone took 7.5k, so the final trim cut the
 * developer's question (#2233 QA).
 */
export function conversationAnswerTokens(
    slot: NormalizedModel | undefined,
): number {
    const windows = [
        slotContextWindow(slot ? { ...slot, fallback: undefined } : undefined),
        ...(slot?.fallback
            ? [slotContextWindow(slot.fallback as NormalizedModel)]
            : []),
    ];
    return Math.max(
        1_024,
        Math.min(
            CONVERSATION_ANSWER_TOKENS,
            Math.floor(Math.min(...windows) / 4),
        ),
    );
}

export interface ConversationWindowParams {
    slot: NormalizedModel | undefined;
    systemPrompt: string;
    tools: readonly unknown[];
    /** The answer the conversation asks for when the slot sets none. */
    answerTokens: number;
}

async function conversationRoom(params: ConversationWindowParams) {
    const window = slotContextWindow(params.slot);
    // Each attempt (the slot, then its fallback) with its own window and
    // its own answer: the room is the smaller of the two.
    const room = await slotInputRoom(params.slot, (model) =>
        declaredAnswerTokens(
            model,
            model?.maxOutputTokens && model.maxOutputTokens > 0
                ? model.maxOutputTokens
                : params.answerTokens,
        ),
    );
    const overhead = estimateOverheadTokens(params.systemPrompt, params.tools);
    return { window, room, overhead };
}

/**
 * The tokens the messages of a conversation step can take: the budget the
 * compressor below enforces (the room less the system prompt, the tool
 * schemas and the safety margin).
 */
export async function conversationMessageBudget(
    params: ConversationWindowParams,
): Promise<number> {
    const { window, room, overhead } = await conversationRoom(params);
    return Math.max(
        0,
        room - overhead - Math.ceil(window * DEFAULT_SAFETY_MARGIN_RATIO),
    );
}

/**
 * Keeps every step of a conversation within its model's window (#2233). A
 * conversation re-sends each tool result on every step, and one PR diff read
 * through `KODUS_GET_PULL_REQUEST_DIFF` sent requests of 3.8M tokens to
 * 1M-token models. The other agents already ran with this compressor; the
 * conversation had none. The answer the call declares stays out of the
 * budget: the slot's own `maxOutputTokens`, and the thinking budget Anthropic
 * adds on top, else the conversation's own answer limit.
 */
export async function conversationCompression(
    params: ConversationWindowParams,
): Promise<CompressionPolicy> {
    const { window, room, overhead } = await conversationRoom(params);
    return new CompressionPolicy(
        new ContextWindowCompressor(window, {
            overheadTokens: overhead,
            safetyMarginTokens:
                Math.ceil(window * DEFAULT_SAFETY_MARGIN_RATIO) +
                (window - room),
            // The PR diff a tool read is what the developer asked about: it
            // stays whole while the request fits (#2681 review).
            onlyWhenOverBudget: true,
            // A dense result (an inline base64 image) undercounted by 3x
            // was sent past the window (#2233).
            countAtWorstCase: true,
        }),
    );
}
