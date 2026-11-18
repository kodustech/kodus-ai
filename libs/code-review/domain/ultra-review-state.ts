import type { NormalizedModel } from '@libs/llm/byok-config';

/**
 * The shape an Ultra review leaves on the pipeline context. Only the types
 * live here; deciding, running and merging Ultra is in libs/ee/ultra-review.
 */

/** One model of an Ultra review: its BYOK model id, label and routed slot. */
export interface UltraModel {
    /** The BYOK `models[]` id. */
    modelId: string;
    /** `provider:model`, for logs, the timeline and the PR notice. */
    modelName: string;
    /** The slot the run calls, with no runtime fallback attached. */
    slot: NormalizedModel;
}

/** Which place a run took: one of the three models, or the org fallback. */
export type UltraRunPosition = 1 | 2 | 3 | 'fallback';

/** What one model's heavy run ended as. */
export interface UltraRunOutcome {
    position: UltraRunPosition;
    modelId: string;
    modelName: string;
    /**
     * `completed`: the generalist finished (no error, not cut short, verify
     * judged everything). `failed`: anything else.
     */
    status: 'completed' | 'failed';
    /** Why the run failed, as logged and shown on the Pull Requests screen. */
    failureReason?: string;
    /** The model id of the fallback that took this run's place. */
    replacedBy?: string;
    /** The fallback is one of the three models: its own review was reused. */
    reusedRun?: boolean;
    /** Findings the run would have published, before the merge. */
    findings?: number;
    durationMs?: number;
}

/** What the cross-model merge ended as. */
export interface UltraMergeOutcome {
    /**
     * `success`: on the merge model. `fallback`: on the org fallback after the
     * merge model failed. `failed`: both failed, the comments went out
     * unmerged. `skipped`: fewer than two lists to merge.
     */
    status: 'success' | 'fallback' | 'failed' | 'skipped';
    modelName?: string;
    inputCount: number;
    outputCount: number;
    errorMessage?: string;
}

export interface UltraReviewState {
    /** The three models, in the order the team set them. */
    models: UltraModel[];
    /** The org fallback, when one is set. */
    fallback?: UltraModel;
    /** The model the merge runs on (the best ranked of the three). */
    mergeModel: UltraModel;
    /** Filled by AgentReviewStage. */
    runs?: UltraRunOutcome[];
    merge?: UltraMergeOutcome;
    /**
     * `success`: three distinct models completed and the merge succeeded.
     * `degraded`: at least one model completed, but not that. `failed`: no
     * model completed.
     */
    outcome?: 'success' | 'degraded' | 'failed';
}
