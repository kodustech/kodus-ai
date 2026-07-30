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
 */
export function resolveKodyRuleBadgeState(
    rule: RuleBadgeInput,
): KodyRuleBadgeState {
    if (rule.status !== KodyRulesStatus.PAUSED) return null;
    return rule.lockedByPlan === true ? "locked" : "paused";
}
