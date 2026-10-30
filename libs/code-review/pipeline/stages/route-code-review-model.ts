import { isByokConfig, LLM_TASK, type NormalizedModel } from '@libs/llm/byok-config';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';

/**
 * The model the codeReview task runs on for an org's stored BYOK config, as
 * ValidateConfigStage writes it into the review config: the routed slot (the
 * id or NAME override applied), or nothing — the env/managed default —
 * when there is no config or the routing is blocked. ValidateConfigStage and
 * the evals' review harness (evals/shared/review-stage.js) both call this.
 */
export function routeCodeReviewModel(
    storedConfig: unknown,
    codeReviewConfig: { byokModelId?: string; byokModel?: string },
): {
    resolvedModelSlot: NormalizedModel | undefined;
    /** A config is stored but routes the codeReview task nowhere. */
    blocked: boolean;
    reason?: string;
} {
    // Override precedence: byokModelId (id) wins over the byokModel NAME.
    const overrideRef =
        codeReviewConfig.byokModelId?.trim() ||
        codeReviewConfig.byokModel?.trim();

    // Resolve the codeReview task's slot + verdict through the single
    // resolution primitive. A null/absent config yields a null slot → the
    // env/managed default downstream.
    const { slot: routedMain, verdict } = isByokConfig(storedConfig)
        ? resolveTaskSlot(storedConfig, LLM_TASK.codeReview, {
              // The strategy handles the id-THEN-name match (REQ-COMPAT-01).
              ctx: overrideRef ? { override: { modelId: overrideRef } } : {},
          })
        : { slot: null, verdict: null };

    return {
        // `routedMain` already has the id/NAME override applied and carries the
        // ciphertext verbatim (resolveTaskSlot never decrypts — T-04-01-01).
        resolvedModelSlot:
            routedMain && isByokConfig(storedConfig) ? routedMain : undefined,
        blocked: isByokConfig(storedConfig) && !verdict?.modelId,
        ...(verdict?.reason ? { reason: verdict.reason } : {}),
    };
}
