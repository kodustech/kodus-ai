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
import type { LanguageModel } from 'ai';

import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { resolveTaskModel } from '@libs/llm/resolve-task-model';

import type { ReviewAgentInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';

type ModelInput = Pick<
    ReviewAgentInput,
    | 'organizationAndTeamData'
    | 'byokModel'
    | 'byokModelId'
    | 'defaultModelOverride'
>;

/**
 * A resolved model plus the knobs the agent loop needs. The `role` union still
 * carries `'fallback'` only for the legacy collaborator typing that dies in the
 * cleanup wave — the runtime fallback itself was removed in 04b-05, so only
 * `'main'` is ever produced here.
 */
export interface AgentModelParams {
    role: 'main' | 'fallback';
    model: LanguageModel;
    modelName: string;
    maxInputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    byokProvider?: string;
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
}

export interface ResolvedAgentModel {
    byokConfig?: BYOKConfig;
    main: AgentModelParams;
}

function buildRoleParams(
    byokConfig: BYOKConfig | undefined,
    defaultModelOverride?: string,
): AgentModelParams {
    const model = byokToVercelModel(byokConfig, 'main', {}, defaultModelOverride);

    const cfg = byokConfig?.main; // removed in 04b-06 (legacy {main,fallback} branch)
    return {
        role: 'main',
        model,
        modelName: getModelName(byokConfig, defaultModelOverride),
        maxInputTokens: cfg?.maxInputTokens,
        reasoningEffort: cfg?.reasoningEffort,
        reasoningConfigOverride: cfg?.reasoningConfigOverride,
        byokProvider: cfg?.provider,
        openrouterProviderOrder: (cfg as any)?.openrouterProviderOrder,
        openrouterAllowFallbacks: (cfg as any)?.openrouterAllowFallbacks,
    };
}

/**
 * Resolve the run's ONE model (no runtime fallback — dropped in 04b-05):
 *  1. org-level BYOK config (scoped locally — no cross-review race)
 *  2. a v2 blob is routed through `StaticTaskStrategy` for the `codeReview`
 *     task (byokModelId id-override first, then the legacy byokModel NAME
 *     during the window); a legacy `{main,fallback}` blob keeps the exact
 *     `byokModel`-onto-`main` behavior.
 *  3. build the Vercel model for `main`; `defaultModelOverride` only kicks in
 *     when there is no BYOK config (trial/public-demo).
 *
 * The v2 branch sources the FULL config via `getBYOKConfigV2Raw` (not the
 * collapsed `getBYOKConfig`, which always yields `main`) so routing is by
 * task, not always main (RESEARCH Pitfall 1).
 */
export async function resolveAgentModel(
    input: ModelInput,
    permissionService: PermissionValidationService,
): Promise<ResolvedAgentModel> {
    const rawV2 = await permissionService.getBYOKConfigV2Raw(
        input.organizationAndTeamData,
    );

    if (rawV2) {
        // v2: resolve the codeReview MAIN model through the single task→model
        // entry point (slice 04b). byokModelId (id) wins over the legacy
        // byokModel NAME; resolveTaskModel handles the id-THEN-name match, the
        // capability gate, and the null-slot → env/managed default degrade.
        const overrideRef =
            input.byokModelId?.trim() || input.byokModel?.trim();
        const resolved = resolveTaskModel(rawV2, 'codeReview', {
            ctx: overrideRef ? { override: { modelId: overrideRef } } : {},
            defaultModelOverride: input.defaultModelOverride,
        });

        // Build the MAIN bundle straight from the resolver's return — the same
        // limit/telemetry fields, now sourced from the routed slot (null on a
        // BLOCKED/managed verdict → env-default model).
        const slot = resolved.slot;
        const main: AgentModelParams = {
            role: 'main',
            model: resolved.model,
            modelName: resolved.modelName,
            maxInputTokens: slot?.maxInputTokens,
            reasoningEffort: slot?.reasoningEffort,
            reasoningConfigOverride: slot?.reasoningConfigOverride,
            byokProvider: slot?.provider,
            openrouterProviderOrder: (slot as any)?.openrouterProviderOrder,
            openrouterAllowFallbacks: (slot as any)?.openrouterAllowFallbacks,
        };

        // 1 model per task: no fallback slot is resolved or returned.
        const byokConfig = (
            slot ? { main: slot } : undefined
        ) as BYOKConfig | undefined;

        return {
            byokConfig,
            main,
        };
    }

    // Legacy {main,fallback}: exact prior behavior, byte-for-byte (else-branch
    // removed in 04b-06).
    let byokConfig = await permissionService.getBYOKConfig(
        input.organizationAndTeamData,
    );

    const overrideModel = input.byokModel?.trim();
    if (overrideModel && byokConfig?.main) { // removed in 04b-06 (legacy branch)
        byokConfig = {
            ...byokConfig,
            main: { ...byokConfig.main, model: overrideModel }, // removed in 04b-06
        };
    }

    return {
        byokConfig: byokConfig ?? undefined,
        main: buildRoleParams(
            byokConfig ?? undefined,
            input.defaultModelOverride,
        ),
    };
}
