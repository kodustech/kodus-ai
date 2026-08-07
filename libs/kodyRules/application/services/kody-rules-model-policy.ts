import type { NormalizedModel } from '@libs/llm/byok-config';

import { environment } from '@libs/ee/configs/environment';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { LLM_TASK } from '@libs/llm/byok-config';
import { KODUS_DEFAULT_MODEL } from '@libs/llm/byok-to-vercel';

/**
 * The Kodus-funded model for Kody Rules generation when there's no BYOK — the
 * shared managed default (DeepSeek V4 Flash via `API_DEEPSEEK_API_KEY`, routed by
 * the resolver's `deepseek-*` prefix). Gemini is dead (project denied access) and
 * must never be used here — see item 9 of docs/plans/fix-kody-rules-generation.md.
 */
export const KODY_RULES_KODUS_MODEL = KODUS_DEFAULT_MODEL;

/**
 * Resolved model policy for a Kody Rules generation run.
 *
 * `generate: false` means the run must be skipped (no model the org is
 * entitled to). `byokConfig`/`modelOverride` feed the resolver:
 * BYOK wins when present; otherwise `modelOverride` forces the Kodus model
 * (DeepSeek); self-hosted resolves the env model (both undefined).
 */
export interface KodyRulesModelPolicy {
    generate: boolean;
    byokConfig?: NormalizedModel;
    modelOverride?: string;
    /** Set when `generate` is false — human-readable reason for the skip. */
    skipReason?: string;
}

/**
 * Decides which model (if any) a Kody Rules generation run may use.
 *
 * Policy (see docs/plans/fix-kody-rules-generation.md). The Kodus-funded model
 * is ALWAYS DeepSeek — Gemini is dead and must never be reached from this flow:
 * - BYOK configured              → client's BYOK model.
 * - Self-hosted (not cloud)      → the deployment's env model (customer keys).
 * - Cloud + dev OR trial         → DeepSeek V4 Flash (Kodus pays).
 * - Cloud + free/paid, no BYOK   → SKIP (generates nothing).
 */
export async function resolveKodyRulesModelPolicy(
    permissionValidationService: PermissionValidationService,
    organizationAndTeamData: OrganizationAndTeamData,
): Promise<KodyRulesModelPolicy> {
    // native: resolve the Kody Rules generation task to a bare model slot. The
    // `ruleGeneration` task inherits the org's `codeReview` model when it has no
    // explicit override (TASK_ROUTING_FALLBACK), so this stays behavior-compatible
    // while letting an org route rule *generation* to its own model. A non-v2 /
    // managed / BLOCKED config yields `null` → fall through to the self-hosted /
    // trial / skip policy below.
    const byokConfig = await permissionValidationService.resolveTaskSlot(
        organizationAndTeamData,
        LLM_TASK.ruleGeneration,
    );
    if (byokConfig) {
        return { generate: true, byokConfig };
    }

    // Self-hosted deployments bring their own model via env (customer keys),
    // not a Kodus-funded model. buildModelFromSlot(undefined) resolves it.
    if (!environment.API_CLOUD_MODE) {
        return { generate: true };
    }

    // Cloud. When Kodus foots the bill (local dev, or an active trial) the model
    // is DeepSeek — explicitly overridden so buildModelFromSlot never falls back
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
