import type { NormalizedModel } from '@libs/llm/byok-config';
import { getModelId } from '@libs/llm/managed-slot';
import { resolveContextWindow } from '@libs/llm/model-context-window';

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
 * A window resolved for the primary alone, capped at its fallback's: `LLM.run`
 * re-sends a failed call to the fallback, so a review planned for a 1M
 * primary overflows a 24k fallback (#2233). A fallback the table doesn't
 * know caps it at the default window, as `slotContextWindow` does.
 */
export function cappedByFallback(
    primaryWindow: number,
    slot: NormalizedModel | undefined,
): number {
    return slot?.fallback
        ? Math.min(
              primaryWindow,
              slotContextWindow(slot.fallback as NormalizedModel),
          )
        : primaryWindow;
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
