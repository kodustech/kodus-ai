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
import { resolveModelSlotFromV2 } from '@libs/llm/normalize-byok-config';
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
 *  2. a v2 blob is routed through `StaticTaskStrategy` for the `codeReview`
 *     task (byokModelId id-override first, then the legacy byokModel NAME
 *     during the window); a legacy `{main,fallback}` blob keeps the exact
 *     `byokModel`-onto-`main` behavior.
 *  3. build the Vercel model for `main`, and for `fallback` when configured;
 *     `defaultModelOverride` only kicks in when there is no BYOK config
 *     (trial/public-demo).
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

        // Build the MAIN bundle straight from the resolver's return — same
        // fields buildRoleParams reads off `byokConfig?.main`, sourced from the
        // routed slot (null on a BLOCKED/managed verdict → env-default model).
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

        // Fallback resolution LEFT AS-IS (removed in 04b-05). The runtime
        // fallback is a separate resilience provider, not the routed task
        // model — the per-repo override never applies to it.
        const fallbackSlot = resolveModelSlotFromV2(
            rawV2,
            rawV2.routing?.fallbackModelId,
        );
        const byokConfig = (
            slot
                ? {
                      main: slot,
                      ...(fallbackSlot ? { fallback: fallbackSlot } : {}),
                  }
                : undefined
        ) as BYOKConfig | undefined;

        return {
            byokConfig,
            main,
            fallback: byokConfig?.fallback
                ? buildRoleParams(
                      byokConfig,
                      'fallback',
                      input.defaultModelOverride,
                  )
                : null,
        };
    }

    // Legacy {main,fallback}: exact prior behavior, byte-for-byte (else-branch
    // removed in 04b-06).
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
        byokConfig: byokConfig ?? undefined,
        main: buildRoleParams(
            byokConfig ?? undefined,
            'main',
            input.defaultModelOverride,
        ),
        fallback: byokConfig?.fallback
            ? buildRoleParams(
                  byokConfig ?? undefined,
                  'fallback',
                  input.defaultModelOverride,
              )
            : null,
    };
}
