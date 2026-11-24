import {
    OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';
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
 * (`isTeamsOrEnterpriseTierAllowed`), plus a Teams or Enterprise plan whose
 * payment failed: while billing is still collecting, a bounced card does not
 * cut a paying customer off its allowlisted Git host; the plan loses it once
 * it is canceled or expires. A license read that never happened
 * (`unavailable`) says nothing about the plan, so it keeps the fixed IP for
 * the teams that turned it on rather than breaking their reviews.
 */
export function isFixedEgressIpPlanAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
): boolean {
    if (license?.unavailable) return true;
    if (license?.subscriptionStatus === SubscriptionStatus.PAYMENT_FAILED) {
        const plan =
            typeof license.planType === 'string'
                ? license.planType.toLowerCase()
                : '';
        return ['teams', 'enterprise'].some(
            (tier) => plan === tier || plan.startsWith(`${tier}_`),
        );
    }
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

/** How a failed direct clone reads, in the words a team sees. */
const BLOCKED_REASON_WORDS = {
    ip_allow_list: 'your Git host only accepts allowlisted IPs',
    unreachable: 'your Git host did not accept the connection',
} as const;

/** The clone failures that look like a host that only accepts Kodus's IP. */
export type FirewallReason = keyof typeof BLOCKED_REASON_WORDS;

/**
 * A direct clone failed the way a host that only accepts Kodus's fixed IP
 * fails, and the team cannot fall back to that IP: its plan does not include
 * it (`plan`), or the team turned it off in Git settings (`turned_off`). The
 * original error is kept as `cause`. Lives in the domain so the review
 * pipeline can tell it from an infrastructure failure by name.
 */
export class FixedEgressIpUnavailableError extends Error {
    constructor(
        readonly reason: FirewallReason,
        readonly blockedBy: 'plan' | 'turned_off',
        options?: { cause?: unknown },
    ) {
        super(
            blockedBy === 'plan'
                ? `Kodus could not clone the repository from its shared network: ${BLOCKED_REASON_WORDS[reason]}. ${FIXED_EGRESS_IP_PLAN_REQUIRED}`
                : `Kodus could not clone the repository from its shared network: ${BLOCKED_REASON_WORDS[reason]}. The fixed outbound IP is turned off for this team; turn on Fixed outbound IP in Settings > Repositories so Kody clones from Kodus's IP.`,
            options,
        );
        this.name = 'FixedEgressIpUnavailableError';
    }
}

/** The error above, also when a caller wrapped it (`cause`). */
export function findFixedEgressIpUnavailable(
    err: unknown,
): FixedEgressIpUnavailableError | undefined {
    let current: unknown = err;
    for (let depth = 0; current && depth < 5; depth++) {
        if (
            (current as { name?: unknown }).name ===
            'FixedEgressIpUnavailableError'
        ) {
            return current as FixedEgressIpUnavailableError;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return undefined;
}
