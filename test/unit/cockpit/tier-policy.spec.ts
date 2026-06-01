import { isCockpitTierAllowed } from '@libs/cockpit/domain/tier-policy';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

/**
 * Authoritative access rule for the cockpit (both UI shell and HTTP
 * endpoints). The matrix below locks the intent documented in the PR:
 *
 *   - Cloud paid: Teams + Enterprise allowed, Free BYOK blocked.
 *   - Licensed self-hosted: Enterprise-only (Teams is cloud-only).
 *   - Unlicensed self-hosted: never.
 *   - Trial: always (treated as Teams-cloud equivalent).
 *   - Invalid / expired / canceled: never.
 */

const planVariants = {
    teams: [
        'teams_byok',
        'teams_byok_annual',
        'teams_managed',
        'teams_managed_annual',
        'teams_managed_legacy',
    ],
    enterprise: [
        'enterprise_byok',
        'enterprise_byok_annual',
        'enterprise_managed',
        'enterprise_managed_annual',
        'enterprise',
    ],
} as const;

describe('isCockpitTierAllowed', () => {
    it('allows all active paid Teams plans on cloud', () => {
        for (const plan of planVariants.teams) {
            expect(
                isCockpitTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.ACTIVE,
                    planType: plan,
                }),
            ).toBe(true);
        }
    });

    it('allows all active paid Enterprise plans on cloud', () => {
        for (const plan of planVariants.enterprise) {
            expect(
                isCockpitTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.ACTIVE,
                    planType: plan,
                }),
            ).toBe(true);
        }
    });

    it('blocks free_byok even on active cloud', () => {
        expect(
            isCockpitTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                planType: 'free_byok',
            }),
        ).toBe(false);
    });

    it('allows Enterprise plans on licensed self-hosted', () => {
        for (const plan of planVariants.enterprise) {
            expect(
                isCockpitTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                    planType: plan,
                }),
            ).toBe(true);
        }
    });

    it('blocks Teams plans on licensed self-hosted (Teams is cloud-only)', () => {
        for (const plan of planVariants.teams) {
            expect(
                isCockpitTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                    planType: plan,
                }),
            ).toBe(false);
        }
    });

    it('blocks unlicensed self-hosted', () => {
        expect(
            isCockpitTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.SELF_HOSTED,
            }),
        ).toBe(false);
    });

    it('allows trial as Teams-cloud equivalent (plan optional)', () => {
        expect(
            isCockpitTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.TRIAL,
            }),
        ).toBe(true);
    });

    it.each([
        SubscriptionStatus.PAYMENT_FAILED,
        SubscriptionStatus.CANCELED,
        SubscriptionStatus.EXPIRED,
    ])('blocks invalid status %s regardless of plan', (status) => {
        // A failed-payment license can still report a planType from
        // before the lapse — don't let that slip through.
        expect(
            isCockpitTierAllowed({
                valid: false,
                subscriptionStatus: status,
                planType: 'enterprise_managed',
            }),
        ).toBe(false);
    });

    it('blocks null / undefined licenses', () => {
        expect(isCockpitTierAllowed(null)).toBe(false);
        expect(isCockpitTierAllowed(undefined)).toBe(false);
    });

    it('blocks active with missing planType', () => {
        expect(
            isCockpitTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.ACTIVE,
            }),
        ).toBe(false);
    });
});
