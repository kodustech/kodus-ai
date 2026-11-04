import type { OrganizationLicense } from "src/features/ee/subscription/_services/billing/types";

const isPlan = (plan: string, name: "teams" | "enterprise") =>
    plan === name || plan.startsWith(`${name}_`);

/**
 * Mirror of `isHeavyModeTierAllowed` in `libs/ee/heavy-mode/heavy-mode-plan.ts`
 * — keep aligned. Heavy mode runs on Teams and Enterprise (cloud, or
 * self-hosted with a Teams or Enterprise key) and on a trial; free and
 * self-hosted without a key run Balanced.
 */
export const isHeavyModePlan = (
    license: OrganizationLicense | null | undefined,
): boolean => {
    if (!license?.valid) return false;
    const plan = (
        ("planType" in license ? license.planType : undefined) ?? ""
    ).toLowerCase();
    const paid = isPlan(plan, "teams") || isPlan(plan, "enterprise");

    switch (license.subscriptionStatus) {
        case "active":
        case "licensed-self-hosted":
            return paid;
        case "trial":
            return true;
        default:
            return false;
    }
};

/** Shown where heavy cannot be picked on the current plan. */
export const HEAVY_MODE_PLAN_TAG = "Teams/Enterprise";
