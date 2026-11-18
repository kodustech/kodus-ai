/**
 * Enterprise Code — see `license_ee.md`. Who runs Ultra review, and on which
 * three models.
 */
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';
import { createLogger } from '@libs/core/log/logger';
import type {
    ILicenseService,
    OrganizationLicenseValidationResult,
} from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';
import {
    isByokConfig,
    LLM_TASK,
    type BYOKConfig,
    type NormalizedModel,
} from '@libs/llm/byok-config';
import { getModelName } from '@libs/llm/managed-slot';
import { resolveModelSlot } from '@libs/llm/resolve-model-slot';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { pickMergeModelIndex } from './ultra-merge-ranking';

const logger = createLogger('UltraReviewPlan');

/** Ultra runs on exactly three models. */
export const ULTRA_MODEL_COUNT = 3;

/**
 * Ultra runs on Teams and Enterprise, in the cloud and self-hosted with a
 * Kodus license key, and on a trial: the same plans as heavy. The three models
 * being the team's own (resolveUltraTrio) is what keeps a trial on Kodus's
 * keys, and free, out.
 */
export function isUltraReviewTierAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
): boolean {
    return isTeamsOrEnterpriseTierAllowed(license, {
        selfHostedTiers: ['teams', 'enterprise'],
    });
}

/**
 * Whether the organization's plan runs Ultra, read on every review so a trial
 * that ends loses it. Fails closed: no license service, or a license that
 * cannot be read, runs no Ultra.
 */
export async function isUltraReviewPlanAllowed(
    licenseService: ILicenseService | undefined,
    organizationAndTeamData: OrganizationAndTeamData,
    logContext: string,
): Promise<boolean> {
    if (!licenseService) return false;
    try {
        const license = await licenseService.validateOrganizationLicense(
            organizationAndTeamData,
        );
        return isUltraReviewTierAllowed(license);
    } catch (error) {
        logger.warn({
            message: 'Could not read the plan for Ultra review',
            context: logContext,
            error,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        });
        return false;
    }
}

/**
 * The ids of the org's own models: a model whose credential carries its own
 * key (or Kodus credits bought for it). The managed trial key is not one.
 */
export function ownModelIds(config: unknown): string[] {
    if (!isByokConfig(config)) return [];
    return (config.models ?? [])
        .filter((m) => m?.id && resolveModelSlot(config, m.id))
        .map((m) => m.id);
}

/** Why an org cannot run Ultra on its models. */
export type UltraTrioRefusal =
    /** Fewer than three own models configured. */
    | { reason: 'too_few_models'; ownModels: number }
    /** Three own models, but no three different ones set for Ultra. */
    | { reason: 'not_configured'; ownModels: number }
    /** None of the three set resolves any more. */
    | { reason: 'unavailable_models'; ownModels: number };

/**
 * The slot an Ultra model runs on: the model routed as the heavy task with
 * its id as the override, so the capability gate still applies, and with no
 * runtime fallback attached, since Ultra spends its one fallback per review,
 * not per call. Undefined when the model no longer resolves or fails the gate.
 */
function ultraSlot(
    config: BYOKConfig,
    modelId: string,
): NormalizedModel | undefined {
    const { slot, verdict } = resolveTaskSlot(
        config,
        LLM_TASK.codeReviewHeavy,
        { ctx: { override: { modelId, byId: true } } },
    );
    if (!slot || verdict?.modelId !== modelId) return undefined;
    const { fallback: _fallback, ...withoutFallback } = slot;
    return withoutFallback as NormalizedModel;
}

const ultraModel = (
    position: UltraModel['position'],
    modelId: string,
    slot: NormalizedModel,
): UltraModel => ({
    position,
    modelId,
    modelName: getModelName(slot),
    slot,
});

/**
 * The org's Ultra review from its stored BYOK config: the three models set
 * for Ultra, each with the slot it runs on, the org fallback and the model the
 * merge runs on. A model of the three that no longer resolves is listed as
 * unavailable and counts as failed when the review runs; Ultra is refused only
 * when none of the three resolves.
 */
export function resolveUltraTrio(
    storedConfig: unknown,
):
    | ({ ok: true } & Pick<
          UltraReviewState,
          'models' | 'unavailable' | 'fallback' | 'mergeModel'
      >)
    | ({ ok: false } & UltraTrioRefusal) {
    const own = ownModelIds(storedConfig);
    if (!isByokConfig(storedConfig) || own.length < ULTRA_MODEL_COUNT) {
        return { ok: false, reason: 'too_few_models', ownModels: own.length };
    }
    const ids = (storedConfig.routing?.ultraModelIds ?? []).map((id) =>
        typeof id === 'string' ? id.trim() : '',
    );
    if (
        ids.length !== ULTRA_MODEL_COUNT ||
        ids.some((id) => !id) ||
        new Set(ids).size !== ULTRA_MODEL_COUNT
    ) {
        return { ok: false, reason: 'not_configured', ownModels: own.length };
    }

    const models: UltraModel[] = [];
    const unavailable: UltraReviewState['unavailable'] = [];
    ids.forEach((modelId, i) => {
        const position = (i + 1) as 1 | 2 | 3;
        const slot = ultraSlot(storedConfig, modelId);
        if (slot) {
            models.push(ultraModel(position, modelId, slot));
        } else {
            unavailable.push({
                position,
                modelId,
                reason: 'The model is no longer configured, or it cannot run a code review.',
            });
        }
    });
    if (!models.length) {
        return {
            ok: false,
            reason: 'unavailable_models',
            ownModels: own.length,
        };
    }

    const fallbackId = storedConfig.routing?.fallbackModelId?.trim();
    const fallbackSlot = fallbackId
        ? ultraSlot(storedConfig, fallbackId)
        : undefined;

    return {
        ok: true,
        models,
        ...(unavailable.length && { unavailable }),
        ...(fallbackSlot && {
            fallback: ultraModel('fallback', fallbackId!, fallbackSlot),
        }),
        mergeModel:
            models[pickMergeModelIndex(models.map((m) => m.slot.model))],
    };
}

/** The refusal of a resolved trio, or undefined when Ultra can run. */
export function ultraTrioRefusal(
    trio: ReturnType<typeof resolveUltraTrio>,
): UltraTrioRefusal | undefined {
    if (trio.ok === true) return undefined;
    const { ok: _ok, ...refusal } = trio as { ok: false } & UltraTrioRefusal;
    return refusal as UltraTrioRefusal;
}

