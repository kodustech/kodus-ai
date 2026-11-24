import type { OrganizationLicenseValidationResult } from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';

/**
 * Said to a team whose plan does not include the fixed outbound IP, when it
 * tries to turn it on or when a direct clone of its Git host fails.
 */
export const FIXED_EGRESS_IP_PLAN_REQUIRED =
    "The fixed outbound IP is available on the Teams and Enterprise plans. Without it, Kodus reaches your Git host from a shared network, so a host that only accepts Kodus's IP refuses the connection.";

/**
 * Whether the organization's plan may send its sandboxes through the fixed
 * outbound IP: Teams, Enterprise and trial, the paid-team matrix
 * (`isTeamsOrEnterpriseTierAllowed`). A license read that never happened
 * (`unavailable`) says nothing about the plan, so it keeps the fixed IP for
 * the teams that turned it on rather than breaking their reviews.
 */
export function isFixedEgressIpPlanAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
): boolean {
    if (license?.unavailable) return true;
    return isTeamsOrEnterpriseTierAllowed(license);
}

/** Turning the fixed outbound IP on for a team whose plan does not include it. */
export class FixedEgressIpPlanRequiredError extends Error {
    constructor() {
        super(FIXED_EGRESS_IP_PLAN_REQUIRED);
        this.name = 'FixedEgressIpPlanRequiredError';
    }
}

/**
 * Turning the fixed outbound IP on while billing cannot say what the plan is.
 * Granting a paid feature on an unread plan would hand it to free teams during
 * a billing outage, so the switch refuses and asks to try again.
 */
export class FixedEgressIpPlanUnconfirmedError extends Error {
    constructor() {
        super(
            'Kodus could not confirm your plan right now, so the fixed outbound IP was not turned on. Try again in a few minutes.',
        );
        this.name = 'FixedEgressIpPlanUnconfirmedError';
    }
}

/** The team has no code management integration to hold its egress setting. */
export class FixedEgressIpNoIntegrationError extends Error {
    constructor() {
        super(
            'Connect a git integration before choosing how Kodus reaches your Git host.',
        );
        this.name = 'FixedEgressIpNoIntegrationError';
    }
}
