import { isTeamsOrEnterprisePlan } from "src/features/ee/byok/_utils";
import type { OrganizationLicense } from "src/features/ee/subscription/_services/billing/types";

/**
 * Mirror of `isHeavyModeTierAllowed` in `libs/ee/heavy-mode/heavy-mode-plan.ts`
 * — keep aligned. Heavy mode runs on Teams and Enterprise (cloud, or
 * self-hosted with a Teams or Enterprise key) and on a trial; free and
 * self-hosted without a key run Balanced.
 */
export const isHeavyModePlan = (
    license: OrganizationLicense | null | undefined,
): boolean =>
    isTeamsOrEnterprisePlan(license, {
        selfHostedTiers: ["teams", "enterprise"],
    });

/** Shown where heavy cannot be picked on the current plan. */
export const HEAVY_MODE_PLAN_TAG = "Teams/Enterprise";
