"use client";

import { useSubscriptionStatus } from "src/core/providers/byok.provider";
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";

import { useSubscriptionContext } from "../_providers/subscription-context";

export type GatedFeatureKey = "cockpit" | "sso" | "activityLogs";

/** The plan that unlocks each gated feature, for tags next to a padlock. */
export const GATE_PLAN_LABEL: Record<GatedFeatureKey, string> = {
    cockpit: "Teams",
    sso: "Enterprise",
    activityLogs: "Enterprise",
};

/**
 * What the current plan unlocks. `true` = unlocked. Mirrors the server-side
 * guards on each page (cockpit layout, sso/page, user-logs/page): menus show
 * every gated entry with a padlock instead of hiding it, and the page itself
 * renders the locked preview when the tier is missing.
 */
export const useFeatureGates = (): Record<GatedFeatureKey, boolean> => {
    const { isEnterprise, isTrial } = useSubscriptionStatus();
    const { license } = useSubscriptionContext();
    return {
        cockpit: isCockpitTierAllowed(license),
        sso: isEnterprise || isTrial,
        activityLogs: isEnterprise || isTrial,
    };
};
