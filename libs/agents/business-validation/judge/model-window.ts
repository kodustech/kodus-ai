import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveContextWindow } from '@libs/llm/model-context-window';

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
 * fallback when the primary fails. Without a slot, the default window.
 */
export function judgeWindow(model: NormalizedModel | undefined): number {
    if (!model) {
        return resolveContextWindow({});
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
    const sent = (slot: Slot | undefined) =>
        slot?.maxOutputTokens && slot.maxOutputTokens > 0
            ? slot.maxOutputTokens
            : requested;
    return {
        requested,
        reserved: Math.max(sent(model), sent(model?.fallback)),
    };
}
