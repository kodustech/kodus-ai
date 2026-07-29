import { UserRole } from "@enums";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import {
    Action,
    ResourceType,
    type PermissionsMap,
} from "@services/permissions/types";
import { hasPermission } from "src/core/utils/permission-map";

import type { OrganizationLicense } from "../subscription/_services/billing/types";
import type {
    BYOKConfigV2,
    BYOKCredential,
    BYOKModelConfig,
} from "./_types";

/** Narrow an unknown blob to the v2 shape by its `version` discriminant. */
const isV2Config = (
    config: BYOKConfigV2 | null | undefined,
): config is BYOKConfigV2 =>
    !!config &&
    typeof config === "object" &&
    (config as { version?: unknown }).version === 2;

/**
 * Group the v2 config's models by NON-managed credential. Returns one group per
 * real (BYOK) credential — `{ credential, models }` where `models` are the
 * config.models[] whose `credentialId` matches. Managed credentials (env
 * defaults) produce NO group and their models are excluded (RFC §4.5 /
 * UI-SPEC "Managed credential: never rendered"). A null/undefined/non-v2 blob
 * yields []. An absent routing block is tolerated.
 */
export const groupModelsByProvider = (
    config: BYOKConfigV2 | null | undefined,
): { credential: BYOKCredential; models: BYOKModelConfig[] }[] => {
    if (!isV2Config(config)) return [];
    const models = config.models ?? [];
    return config.credentials
        .filter((c) => !c.managed)
        .map((credential) => ({
            credential,
            models: models.filter((m) => m.credentialId === credential.id),
        }));
};

/**
 * First-run check: true when the org has ≥1 NON-managed credential carrying at
 * least one model. The v2-native replacement for the legacy
 * `Boolean(byokConfig?.main)` presence check. False for null/undefined, a
 * non-v2 blob, a managed-only config, or a non-managed credential with no model.
 */
export const hasVisibleModels = (
    config: BYOKConfigV2 | null | undefined,
): boolean =>
    groupModelsByProvider(config).some((group) => group.models.length > 0);

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
