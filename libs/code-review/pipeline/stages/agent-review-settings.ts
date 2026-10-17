import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { getModelName } from '@libs/llm/byok-to-vercel';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * What AgentReviewStage settles from the review config before it hands the PR
 * to the agents: which categories run, and the adaptive-fit profile for the
 * model the codeReview task resolved to. Called by AgentReviewStage, which the
 * evals drive (evals/shared/review-stage.js).
 */
export function resolveAgentReviewSettings(
    codeReviewConfig: CodeReviewPipelineContext['codeReviewConfig'] | undefined,
) {
    const reviewOptions = codeReviewConfig?.reviewOptions || {
        bug: true,
        security: true,
        performance: true,
    };

    // The profile drives which fidelity strategies (drop callGraph, compact
    // prompt, etc) fire and is also passed through to
    // BaseCodeReviewAgentProvider via ReviewAgentInput so per-agent code paths
    // gate on the same flags. Per-repo/directory model override (byokModel)
    // takes priority over the org-level main.model when present — same
    // resolution the agent uses internally.
    const resolvedSlot = codeReviewConfig?.resolvedModelSlot;
    // byokModelId (id) wins over the legacy byokModel NAME (D-05). When a
    // byokModelId is set, ValidateConfigStage has already routed the
    // codeReview task to that id-addressed model into the resolved slot (same
    // routing the model factory runs), so the legacy NAME re-apply is skipped
    // here — the id-routed model stands. Only when no id is set does the
    // legacy NAME window still apply the override onto the slot.
    const overrideModel = codeReviewConfig?.byokModelId?.trim()
        ? undefined
        : codeReviewConfig?.byokModel?.trim();
    const effectiveSlot =
        overrideModel && resolvedSlot
            ? { ...resolvedSlot, model: overrideModel }
            : resolvedSlot;
    // Same model-name formatter the agent uses (provider:model), so
    // stage-emitted and agent-emitted warnings share a dedup key.
    const effectiveModelName = getModelName(effectiveSlot ?? undefined);
    const effectiveContextWindow = resolveContextWindow({
        byokMaxInputTokens: resolvedSlot?.maxInputTokens,
        modelName: overrideModel || resolvedSlot?.model || '',
    });
    const adaptiveProfile = resolveAdaptiveProfile(effectiveContextWindow);

    return {
        reviewOptions,
        effectiveModelName,
        effectiveContextWindow,
        adaptiveProfile,
    };
}
