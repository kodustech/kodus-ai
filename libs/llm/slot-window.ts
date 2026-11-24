import type { NormalizedModel } from '@libs/llm/byok-config';
import { getModelId } from '@libs/llm/managed-slot';
import {
    resolveContextWindow,
    resolveContextWindowWithSource,
} from '@libs/llm/model-context-window';

/**
 * The input window every call on this slot must fit: the smaller of the
 * slot's and its fallback's, since `LLM.run` sends the same request to the
 * fallback when the primary fails. Without a slot, the window of the model
 * that runs then: the env-configured one on a self-hosted install, else the
 * managed default.
 */
export function slotContextWindow(slot: NormalizedModel | undefined): number {
    if (!slot) {
        return resolveContextWindow({ modelName: getModelId(undefined) });
    }
    const windowOf = (model: Omit<NormalizedModel, 'fallback'>) =>
        resolveContextWindow({
            byokMaxInputTokens: model.maxInputTokens,
            modelName: model.model ?? '',
        });
    return slot.fallback
        ? Math.min(windowOf(slot), windowOf(slot.fallback))
        : windowOf(slot);
}

/**
 * `slotContextWindow` when the slot or the model table knows the primary's
 * window; undefined when only the default guess would answer it. For a
 * caller that had no limit at all before: a guessed window would split or
 * skip calls a larger model takes. A fallback whose window is unknown caps a
 * known primary at the default guess: the call may go to it, and sizing it
 * for the primary alone is the overflow #2233 is about.
 */
export function knownSlotContextWindow(
    slot: NormalizedModel | undefined,
): number | undefined {
    const resolve = (model: Omit<NormalizedModel, 'fallback'> | undefined) =>
        resolveContextWindowWithSource({
            byokMaxInputTokens: model?.maxInputTokens,
            modelName: model ? (model.model ?? '') : getModelId(undefined),
        });
    const primary = resolve(slot);
    if (primary.source === 'default') {
        // The primary's window is a guess: the fallback's, when it is known,
        // is the only limit anyone knows.
        const fallback = slot?.fallback ? resolve(slot.fallback) : undefined;
        return fallback && fallback.source !== 'default'
            ? fallback.tokens
            : undefined;
    }
    return slot?.fallback
        ? Math.min(primary.tokens, resolve(slot.fallback).tokens)
        : primary.tokens;
}

/**
 * The input a call on this slot can send and still fit, on every attempt:
 * `LLM.run` re-sends a failed call to the fallback, which brings its own
 * window and its own answer. The smaller of `window - answer` over the
 * attempts; never the smallest window beside the largest answer, which can
 * leave less than nothing for a pair no attempt actually is (a 64k-answer
 * primary with a 32k-window fallback).
 */
export async function slotInputRoom(
    slot: NormalizedModel | undefined,
    answerOf: (model: NormalizedModel | undefined) => Promise<number>,
): Promise<number> {
    const attempts: Array<NormalizedModel | undefined> = slot
        ? [
              { ...slot, fallback: undefined },
              ...(slot.fallback ? [slot.fallback as NormalizedModel] : []),
          ]
        : [undefined];
    const rooms = await Promise.all(
        attempts.map(
            async (model) => slotContextWindow(model) - (await answerOf(model)),
        ),
    );
    return Math.min(...rooms);
}
