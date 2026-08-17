import { KodyRulesStatus } from "@services/kodyRules/types";

type RuleBadgeInput = {
    status: KodyRulesStatus;
    lockedByPlan?: boolean;
};

export type KodyRuleBadgeState = "locked" | "paused" | null;

/**
 * Which status badge a Kody Rule item should show. A rule PAUSED because it
 * exceeded the free plan's active-rule quota (`lockedByPlan`) renders as
 * "Locked" with an upgrade CTA; a rule the user paused themselves renders
 * as the plain "Paused" badge. Both share the same underlying PAUSED status,
 * so this is the single place that decides which one the user sees.
 *
 * Accepts an optional `isFreePlan` flag as a second line of defense: on paid
 * plans with stale cached data (`lockedByPlan` still true from before an
 * upgrade) the badge correctly shows "paused" instead of "locked".
 */
export function resolveKodyRuleBadgeState(
    rule: RuleBadgeInput,
    isFreePlan?: boolean,
): KodyRuleBadgeState {
    if (rule.status !== KodyRulesStatus.PAUSED) return null;

    // Only show "locked" badge on FREE plans when rule was auto-paused by quota.
    // On a paid plan (or user-paused), show the plain "paused" badge.
    const showLocked = rule.lockedByPlan === true && isFreePlan !== false;
    return showLocked ? "locked" : "paused";
}
