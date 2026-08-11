import {
    OrganizationLicenseValidationResult,
} from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';

/**
 * Cockpit tier policy — single source of truth for "who can access the
 * cockpit" (both the UI shell and any cockpit HTTP endpoint). Keep the
 * frontend copy in `apps/web/src/features/ee/cockpit/_helpers/tier-policy.ts`
 * aligned with this function when the rule changes.
 *
 * Delegates to `isTeamsOrEnterpriseTierAllowed` (same matrix as linked
 * repositories / other Teams+Enterprise product features).
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
    return isTeamsOrEnterpriseTierAllowed(license);
}
