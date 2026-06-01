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
 * Obfuscate an API key for display so shoulder-surfing and screen-sharing
 * can't leak the secret. Keeps a short prefix + suffix so the user can
 * still recognize which key is stored.
 */
export const maskKey = (key?: string): string => {
    if (!key) return "";
    if (key.length <= 8) return "•••• ••••";
    return `${key.slice(0, 4)}•••••${key.slice(-4)}`;
};
