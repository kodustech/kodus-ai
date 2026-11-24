import type { NormalizedModel } from '@libs/llm/byok-config';
import { getModelId } from '@libs/llm/managed-slot';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { reasoningBudgetAddedToAnswer } from '@libs/llm/model-invocation';

/** The most the analyzer may write when the slot sets no limit of its own. */
export const ANALYZER_MAX_OUTPUT_TOKENS = 20_000;

/**
 * At most this share of a small window goes to the answer: at 20k tokens a
 * 16k or 24k window had nothing left for the diff.
 */
const ANALYZER_OUTPUT_WINDOW_SHARE = 0.25;

type Slot = Omit<NormalizedModel, 'fallback'>;

function windowOf(slot: Slot): number {
    return resolveContextWindow({
        byokMaxInputTokens: slot.maxInputTokens,
        modelName: slot.model ?? '',
    });
}

/**
 * The input window every call of the judge must fit: the smaller of the
 * slot's and its fallback's, since `LLM.run` sends the same request to the
 * fallback when the primary fails. Without a slot, the window of the model
 * that runs then: the env-configured one on a self-hosted install, else the
 * managed default.
 */
export function judgeWindow(model: NormalizedModel | undefined): number {
    if (!model) {
        return resolveContextWindow({ modelName: getModelId(undefined) });
    }
    return model.fallback
        ? Math.min(windowOf(model), windowOf(model.fallback))
        : windowOf(model);
}

/**
 * The answer the analyzer is allowed: 20k tokens, or a quarter of a smaller
 * window. A slot's own `maxOutputTokens` is what `runAgentLoopCall` sends
 * whatever the caller asks, so it is what the call keeps room for.
 */
export function analyzerOutputTokens(model: NormalizedModel | undefined): {
    /** What the analyzer asks for. */
    requested: number;
    /** What the call may really spend: the room kept in the window. */
    reserved: number;
} {
    const requested = Math.min(
        ANALYZER_MAX_OUTPUT_TOKENS,
        Math.floor(judgeWindow(model) * ANALYZER_OUTPUT_WINDOW_SHARE),
    );
    return { requested, reserved: reservedOutputTokens(model, requested) };
}

/**
 * The answer room a call on this slot keeps in the window, for a caller that
 * asks for `requested`: the slot's own `maxOutputTokens` wins in
 * `runAgentLoopCall`, and Anthropic and Bedrock add the thinking budget on
 * top (`max_tokens = answer + budget`). With a fallback, the larger of what
 * each would send. Not capped by the window: the call declares that much
 * whatever room is left, and a provider rejects input plus answer above the
 * window, so a slot whose answer fills its window can't be judged.
 */
export function reservedOutputTokens(
    model: NormalizedModel | undefined,
    requested: number,
): number {
    const sent = (slot: Slot | undefined) =>
        (slot?.maxOutputTokens && slot.maxOutputTokens > 0
            ? slot.maxOutputTokens
            : requested) + reasoningBudgetAddedToAnswer(slot);
    return model?.fallback
        ? Math.max(sent(model), sent(model.fallback))
        : sent(model);
}
