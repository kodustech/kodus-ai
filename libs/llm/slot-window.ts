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
 * `slotContextWindow` when the slot or the model table knows it; undefined
 * when only the default guess would answer. For a caller that had no limit at
 * all before: a guessed window would split or skip calls a larger model takes.
 */
export function knownSlotContextWindow(
    slot: NormalizedModel | undefined,
): number | undefined {
    const known = (model: Omit<NormalizedModel, 'fallback'> | undefined) => {
        const resolved = resolveContextWindowWithSource({
            byokMaxInputTokens: model?.maxInputTokens,
            modelName: model ? (model.model ?? '') : getModelId(undefined),
        });
        return resolved.source === 'default' ? undefined : resolved.tokens;
    };
    const primary = known(slot);
    const fallback = slot?.fallback ? known(slot.fallback) : undefined;
    if (primary === undefined) {
        return fallback;
    }
    return fallback === undefined ? primary : Math.min(primary, fallback);
}
