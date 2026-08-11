import { UserRole } from "@enums";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import {
    Action,
    ResourceType,
    type PermissionsMap,
} from "@services/permissions/types";
import { hasPermission } from "src/core/utils/permission-map";

import type { OrganizationLicense } from "../subscription/_services/billing/types";

export const isBYOKSubscriptionPlan = (license: OrganizationLicense) => {
    if (
        license.subscriptionStatus === "self-hosted" ||
        license.subscriptionStatus === "licensed-self-hosted"
    ) {
        return true;
    }
    // Trial orgs don't carry a planType (they're exploring), but they
    // should still see the BYOK setup path — previously we required
    // "active", which blocked trial users from configuring their own
    // key during the trial. Canceled / expired / payment_failed /
    // inactive stay excluded.
    if (license.subscriptionStatus === "trial") {
        return true;
    }
    if (license.subscriptionStatus !== "active") {
        return false;
    }
    return license.planType.includes("byok");
};

export const isEnterprisePlan = (license: OrganizationLicense): boolean => {
    // Mirror of `isEnterpriseTierAllowed` in
    // `libs/ee/license/tier/enterprise-tier-policy.ts` — keep aligned.
    // CE self-hosted (no key) is modeled here as
    // `{ valid: true, subscriptionStatus: "self-hosted" }` and falls
    // into the `default` branch.
    if (!license.valid) return false;

    switch (license.subscriptionStatus) {
        case "active":
        case "licensed-self-hosted": {
            const plan = license.planType ?? "";
            return plan.startsWith("enterprise_") || plan === "enterprise";
        }
        case "trial":
            return true;
        default:
            return false;
    }
};

/**
 * Mirror of `isTeamsOrEnterpriseTierAllowed` in
 * `libs/ee/license/tier/teams-or-enterprise-tier-policy.ts` — keep aligned.
 *
 * Used by paid-team features such as linked repositories (cross-repo
 * context) and cockpit analytics.
 */
export const isTeamsOrEnterprisePlan = (
    license: OrganizationLicense,
): boolean => {
    if (!license.valid) return false;
    const plan = license.planType ?? "";
    const isTeams = plan.startsWith("teams_");
    const isEnterprise =
        plan.startsWith("enterprise_") || plan === "enterprise";

    switch (license.subscriptionStatus) {
        case "active":
            return isTeams || isEnterprise;
        case "licensed-self-hosted":
            return isEnterprise;
        case "trial":
            return true;
        default:
            return false;
    }
};

export const shouldShowBYOKMissingKeyTopbar = (params: {
    license: OrganizationLicense | null;
    llmConfigStatus: LLMConfigStatus | null | undefined;
    permissions: PermissionsMap;
    organizationId: string;
    role?: UserRole;
}) => {
    const { license, llmConfigStatus, permissions, organizationId, role } =
        params;

    if (!license || !isBYOKSubscriptionPlan(license)) {
        return false;
    }

    // Either source (DB BYOK or self-hosted `.env`) is enough to run reviews.
    // Only nag when nothing is configured at all.
    if (llmConfigStatus && llmConfigStatus.source !== "none") {
        return false;
    }

    // Trial orgs can configure BYOK if they want, but we don't nag them
    // with the persistent "missing key" topbar — the alert is only for
    // paying plans where BYOK is expected.
    if (license.subscriptionStatus === "trial") {
        return false;
    }

    if (role === UserRole.OWNER) {
        return true;
    }

    return hasPermission({
        permissions,
        organizationId,
        action: Action.Update,
        resource: ResourceType.OrganizationSettings,
    });
};

/**
 * Mirror of `supportsSamplingParams` in `libs/llm/anthropic-model-traits.ts`
 * — keep aligned.
 *
 * Anthropic removed temperature / top_p / top_k from Claude 4.7 onward:
 * sending one is a 400 that fails the whole request. The backend already
 * withholds the value, so this only decides whether we show a field that
 * could not take effect. An unrecognized Claude is treated as new (same bias
 * as the backend) — a model we can't place is far more likely to be newer
 * than one of the handful of legacy ids.
 */
export const anthropicRejectsTemperature = (
    provider?: string,
    model?: string,
): boolean => {
    if (provider !== "anthropic") return false;
    if (!model?.trim()) return true;

    let name = model.trim().toLowerCase();
    const colon = name.indexOf(":");
    if (colon > -1) name = name.slice(colon + 1);
    if (name.startsWith("anthropic.")) name = name.slice("anthropic.".length);
    name = name.split("@")[0].replace(/-\d{8}$/, "");

    // Claude 2.x / 3.x, and 4 through 4.5, still accept sampling params — as
    // does 4.6, the last generation before they were removed.
    const acceptsSamplingParams =
        /^claude-[23](\b|[-.])/.test(name) ||
        /^claude-(opus|sonnet|haiku)-4(-[0-6])?$/.test(name);

    return !acceptsSamplingParams;
};

/**
 * Obfuscate an API key for display so shoulder-surfing and screen-sharing
 * can't leak the secret. Keeps a short prefix + suffix so the user can
 * still recognize which key is stored.
 */
export const maskKey = (key?: string): string => {
    if (!key) return "";
    if (key.length <= 8) return "•••• ••••";
    return `${key.slice(0, 4)}•••••${key.slice(-4)}`;
};
