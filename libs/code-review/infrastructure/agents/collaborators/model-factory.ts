/**
 * code-review (domain) — resolve the BYOK config + Vercel AI SDK model for a run.
 *
 * Phase 4 of the provider decomposition. Pulls the "config → model" resolution
 * out of BaseCodeReviewAgentProvider: org BYOK config + per-repo/directory model
 * override + trial default fallback. The permission service is injected.
 *
 * Resolves BOTH roles so the provider can retry a failed `main` provider against
 * the org's configured `fallback` (see model-fallback.ts). The per-repo override
 * only applies to `main`; `fallback` stays exactly as configured (it is a
 * separate provider chosen for resilience, not a model to be overridden).
 */
import type { LanguageModel } from 'ai';

import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

import type { ReviewAgentInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';

type ModelInput = Pick<
    ReviewAgentInput,
    'organizationAndTeamData' | 'byokModel' | 'defaultModelOverride'
>;

/**
 * A resolved model plus the role-specific knobs the agent loop needs. Bundling
 * these per role lets the provider swap the whole set atomically when it falls
 * back — the loop must never mix `main`'s reasoning config with `fallback`'s
 * model. `fallback` BYOK configs carry no reasoning/openrouter settings, so
 * those fields are only ever populated for `main`.
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
    /** Populated only when the org configured a fallback provider. */
    fallback: AgentModelParams | null;
}

function buildRoleParams(
    byokConfig: BYOKConfig | undefined,
    role: 'main' | 'fallback',
    defaultModelOverride?: string,
): AgentModelParams {
    const model = byokToVercelModel(byokConfig, role, {}, defaultModelOverride);

    if (role === 'fallback') {
        const cfg = byokConfig?.fallback;
        return {
            role,
            model,
            modelName: cfg
                ? `${cfg.provider}:${cfg.model}`
                : getModelName(byokConfig, defaultModelOverride),
            maxInputTokens: cfg?.maxInputTokens,
            byokProvider: cfg?.provider,
        };
    }

    const cfg = byokConfig?.main;
    return {
        role,
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
 * Resolve the run's models:
 *  1. org-level BYOK config (scoped locally — no cross-review race)
 *  2. apply the per-repo/directory `byokModel` override onto `main`
 *  3. build the Vercel model for `main`, and for `fallback` when configured;
 *     `defaultModelOverride` only kicks in when there is no BYOK config
 *     (trial/public-demo).
 */
export async function resolveAgentModel(
    input: ModelInput,
    permissionService: PermissionValidationService,
): Promise<ResolvedAgentModel> {
    let byokConfig = await permissionService.getBYOKConfig(
        input.organizationAndTeamData,
    );

    const overrideModel = input.byokModel?.trim();
    if (overrideModel && byokConfig?.main) {
        byokConfig = {
            ...byokConfig,
            main: { ...byokConfig.main, model: overrideModel },
        };
    }

    return {
        byokConfig,
        main: buildRoleParams(byokConfig, 'main', input.defaultModelOverride),
        fallback: byokConfig?.fallback
            ? buildRoleParams(byokConfig, 'fallback', input.defaultModelOverride)
            : null,
    };
}
