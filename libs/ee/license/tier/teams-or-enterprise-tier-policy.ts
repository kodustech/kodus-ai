import {
    OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '../interfaces/license.interface';

/**
 * Teams or Enterprise tier policy — source of truth for paid-team features
 * (linked repositories / cross-repo context, and cockpit analytics).
 *
 * Keep the frontend mirror in
 * `apps/web/src/features/ee/byok/_utils.ts` (`isTeamsOrEnterprisePlan`)
 * and `apps/web/src/features/ee/cockpit/_helpers/tier-policy.ts` aligned.
 *
 * Allowed:
 *   - cloud paid (`active`) on Teams or Enterprise plans
 *   - licensed self-hosted on any Enterprise plan
 *   - trial (treated as Teams-cloud preview)
 *
 * Blocked:
 *   - invalid / expired / canceled / payment_failed
 *   - unlicensed self-hosted (`self-hosted`)
 *   - free_byok (any status)
 *   - licensed self-hosted on Teams plans (Teams is cloud-only), unless
 *     `selfHostedTiers` includes `teams`
 */
/** The plan tiers a licensed self-hosted key can carry. */
export type SelfHostedTier = 'teams' | 'enterprise';

const isTier = (plan: string, tier: SelfHostedTier) =>
    plan === tier || plan.startsWith(`${tier}_`);

/**
 * `selfHostedTiers` names the key tiers that run the feature self-hosted:
 * Enterprise only by default, as above; heavy mode also lets a Teams key run
 * it.
 */
export function isTeamsOrEnterpriseTierAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
    options: { selfHostedTiers?: readonly SelfHostedTier[] } = {},
): boolean {
    if (!license || !license.valid) return false;
    const rawPlan = license.planType;
    const plan = typeof rawPlan === 'string' ? rawPlan.toLowerCase() : '';
    const isTeams = isTier(plan, 'teams');
    const isEnterprise = isTier(plan, 'enterprise');
    const selfHostedTiers = options.selfHostedTiers ?? ['enterprise'];

    switch (license.subscriptionStatus) {
        case SubscriptionStatus.ACTIVE:
            return isTeams || isEnterprise;
        case SubscriptionStatus.LICENSED_SELF_HOSTED:
            return (
                (isTeams && selfHostedTiers.includes('teams')) ||
                (isEnterprise && selfHostedTiers.includes('enterprise'))
            );
        case SubscriptionStatus.TRIAL:
            return true;
        default:
            return false;
    }
}
