import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';

/** An Ultra model as stored: the slot (and its key ciphertext) left out. */
export interface UltraModelRecord {
    position: UltraModel['position'];
    modelId: string;
    modelName: string;
}

export type UltraReviewRecord = Omit<
    UltraReviewState,
    'models' | 'fallback' | 'mergeModel'
> & {
    models: UltraModelRecord[];
    fallback?: UltraModelRecord;
    mergeModel: UltraModelRecord;
};

const record = (m: UltraModel): UltraModelRecord => ({
    position: m.position,
    modelId: m.modelId,
    modelName: m.modelName,
});

/**
 * What the execution keeps of an Ultra review for the Pull Requests screen:
 * each model's outcome and the merge, never a slot.
 */
export function ultraReviewRecord(
    state: UltraReviewState | undefined,
): UltraReviewRecord | undefined {
    if (!state) return undefined;
    return {
        ...state,
        models: state.models.map(record),
        ...(state.fallback && { fallback: record(state.fallback) }),
        mergeModel: record(state.mergeModel),
    };
}
