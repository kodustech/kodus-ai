import {
    OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';

/**
 * Cockpit tier policy — single source of truth for "who can access the
 * cockpit" (both the UI shell and any cockpit HTTP endpoint). Keep the
 * frontend copy in `apps/web/src/features/ee/cockpit/_helpers/tier-policy.ts`
 * aligned with this function when the rule changes.
 *
 * Allowed:
 *   - cloud paid (subscriptionStatus=active) on Teams or Enterprise plans
 *   - licensed self-hosted on any Enterprise plan
 *   - trial (treated as Teams-cloud equivalent)
 *
 * Blocked:
 *   - invalid / expired / canceled licenses
 *   - unlicensed self-hosted (subscriptionStatus=self-hosted)
 *   - free_byok (any status)
 *   - licensed self-hosted on Teams plans (Teams is cloud-only)
 */
export function isCockpitTierAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
): boolean {
    if (!license || !license.valid) return false;
    const plan = license.planType ?? '';
    const isTeams = plan.startsWith('teams_');
    const isEnterprise =
        plan.startsWith('enterprise_') || plan === 'enterprise';

    switch (license.subscriptionStatus) {
        case SubscriptionStatus.ACTIVE:
            return isTeams || isEnterprise;
        case SubscriptionStatus.LICENSED_SELF_HOSTED:
            return isEnterprise;
        case SubscriptionStatus.TRIAL:
            return true;
        default:
            return false;
    }
}
