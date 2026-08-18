import { BYOKConfig } from '@kodus/kodus-common/llm';

import { environment } from '@libs/ee/configs/environment';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { KODUS_TRIAL_MODEL } from '@libs/llm/byok-to-vercel';

/**
 * The Kodus-funded model for Kody Rules generation when there's no BYOK:
 * DeepSeek V4 Flash hosted on Fireworks (`API_FIREWORKS_API_KEY`), routed by
 * `byokToVercelModel`'s `accounts/fireworks/models/` prefix detection. Gemini
 * is dead (project denied access) and must never be used here — see item 9 of
 * docs/plans/fix-kody-rules-generation.md.
 */
export const KODY_RULES_KODUS_MODEL = KODUS_TRIAL_MODEL;

/**
 * Resolved model policy for a Kody Rules generation run.
 *
 * `generate: false` means the run must be skipped (no model the org is
 * entitled to). `byokConfig`/`modelOverride` feed `byokToVercelModel`:
 * BYOK wins when present; otherwise `modelOverride` forces the Kodus model
 * (DeepSeek); self-hosted resolves the env model (both undefined).
 */
export interface KodyRulesModelPolicy {
    generate: boolean;
    byokConfig?: BYOKConfig;
    modelOverride?: string;
    /** Set when `generate` is false — human-readable reason for the skip. */
    skipReason?: string;
}

/**
 * Decides which model (if any) a Kody Rules generation run may use.
 *
 * Policy (see docs/plans/fix-kody-rules-generation.md). The Kodus-funded model
 * is ALWAYS the Fireworks-hosted DeepSeek V4 Flash — Gemini is dead and must
 * never be reached from this flow:
 * - BYOK configured              → client's BYOK model.
 * - Self-hosted (not cloud)      → the deployment's env model (customer keys).
 * - Cloud + dev OR trial         → DeepSeek V4 Flash on Fireworks (Kodus pays).
 * - Cloud + free/paid, no BYOK   → SKIP (generates nothing).
 */
export async function resolveKodyRulesModelPolicy(
    permissionValidationService: PermissionValidationService,
    organizationAndTeamData: OrganizationAndTeamData,
): Promise<KodyRulesModelPolicy> {
    const byokConfig = await permissionValidationService.getBYOKConfig(
        organizationAndTeamData,
    );
    if (byokConfig) {
        return { generate: true, byokConfig };
    }

    // Self-hosted deployments bring their own model via env (customer keys),
    // not a Kodus-funded model. byokToVercelModel(undefined) resolves it.
    if (!environment.API_CLOUD_MODE) {
        return { generate: true };
    }

    // Cloud. When Kodus foots the bill (local dev, or an active trial) the model
    // is DeepSeek — explicitly overridden so byokToVercelModel never falls back
    // to its dead Gemini default.
    const subscriptionStatus =
        await permissionValidationService.getSubscriptionStatus(
            organizationAndTeamData,
        );

    if (environment.API_DEVELOPMENT_MODE || subscriptionStatus === 'trial') {
        return { generate: true, modelOverride: KODY_RULES_KODUS_MODEL };
    }

    return {
        generate: false,
        skipReason: subscriptionStatus
            ? `no BYOK configured on '${subscriptionStatus}' plan — Kody Rules generation requires BYOK outside the trial`
            : 'no BYOK configured and no active trial — Kody Rules generation skipped',
    };
}
