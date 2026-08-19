/**
 * code-review (domain) — resolve the BYOK config + Vercel AI SDK model for a run.
 *
 * Phase 4 of the provider decomposition. Pulls the "config → model" resolution
 * out of BaseCodeReviewAgentProvider: org BYOK config + per-repo/directory model
 * override + trial default. The permission service is injected.
 *
 * Resolves ONE model per run (1 model per task — the runtime error-recovery
 * fallback was dropped in 04b-05). The per-repo override applies to that model.
 */
import type { ReasoningEffort } from '@libs/llm/reasoning-options';
import type { LlmTask, NormalizedModel } from '@libs/llm/byok-config';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { LLM_TASK } from '@libs/llm/byok-config';
import { getModelName } from '@libs/llm/byok-to-vercel';

import type { ReviewAgentInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';

type ModelInput = Pick<
    ReviewAgentInput,
    | 'organizationAndTeamData'
    | 'byokModel'
    | 'byokModelId'
    | 'defaultModelOverride'
>;

/**
 * A resolved model plus the knobs the agent loop needs. One model per task
 * (the runtime fallback was removed in 04b-05), so `role` is always `'main'`.
 */
export interface AgentModelParams {
    role: 'main';
    modelName: string;
    maxInputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    byokProvider?: string;
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
}

export interface ResolvedAgentModel {
    byokConfig?: NormalizedModel;
    main: AgentModelParams;
}

/**
 * Resolve the run's ONE model (no runtime fallback — dropped in 04b-05),
 * native (04b-06 — the legacy `{main,fallback}` branch is GONE):
 *  1. route the `codeReview` task through the single task→model entry point
 *     owned by the permission service (`resolveTaskModel(org, task, …)`), which
 *     sources the org's config and runs `StaticTaskStrategy` (byokModelId
 *     id-override first, then the legacy byokModel NAME during the window). A
 *     null/non-config degrades to a null slot → env/managed default.
 *  2. `defaultModelOverride` only kicks in when there is no BYOK config
 *     (trial/public-demo).
 *
 * Routing by task (not a collapsed always-main carrier) is preserved inside the
 * resolver (RESEARCH Pitfall 1).
 */
export async function resolveReviewAgentModel(
    input: ModelInput,
    permissionService: PermissionValidationService,
    // Which routing task this agent resolves. Defaults to `codeReview` (the
    // bug/perf/security/generalist agents); the Kody-Rules agent passes
    // `kodyRulesReview` so an org can route it to its own model (it inherits
    // `codeReview` when unset — TASK_ROUTING_FALLBACK).
    task: LlmTask = LLM_TASK.codeReview,
): Promise<ResolvedAgentModel> {
    // Route the `task` to its slot through the single task→slot entry point owned
    // by the permission service. byokModelId (id) wins over the legacy byokModel
    // NAME; resolveTaskSlot handles the id-THEN-name match, the capability gate,
    // and the null-slot → env/managed default degrade (no BYOK too). No model is
    // BUILT here — LLM.run builds + wraps it from the slot at call time (one door).
    const overrideRef = input.byokModelId?.trim() || input.byokModel?.trim();
    const slot = await permissionService.resolveTaskSlot(
        input.organizationAndTeamData,
        task,
        { ctx: overrideRef ? { override: { modelId: overrideRef } } : {} },
    );

    // The MAIN bundle from the routed slot (undefined on a BLOCKED/managed verdict
    // or no BYOK → the env/managed default, whose NAME `defaultModelOverride`
    // still sets). `modelName` is the human `provider:model` label for telemetry.
    const main: AgentModelParams = {
        role: 'main',
        modelName: getModelName(slot, input.defaultModelOverride),
        maxInputTokens: slot?.maxInputTokens,
        reasoningEffort: slot?.reasoningEffort,
        reasoningConfigOverride: slot?.reasoningConfigOverride,
        byokProvider: slot?.provider,
        openrouterProviderOrder: (slot as any)?.openrouterProviderOrder,
        openrouterAllowFallbacks: (slot as any)?.openrouterAllowFallbacks,
    };

    // 1 model per task: no fallback slot is resolved or returned. No BYOK →
    // null slot → `undefined` byokConfig (the optional-field contract; callers
    // gate on `!!byokConfig`), matching a missing config.
    const byokConfig = slot ?? undefined;

    return { byokConfig, main };
}
