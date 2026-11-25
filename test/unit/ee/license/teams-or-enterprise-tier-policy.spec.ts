import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';

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

describe('isTeamsOrEnterpriseTierAllowed', () => {
    it('allows all active paid Teams plans on cloud', () => {
        for (const plan of planVariants.teams) {
            expect(
                isTeamsOrEnterpriseTierAllowed({
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
                isTeamsOrEnterpriseTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.ACTIVE,
                    planType: plan,
                }),
            ).toBe(true);
        }
    });

    it('blocks free_byok even on active cloud', () => {
        expect(
            isTeamsOrEnterpriseTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                planType: 'free_byok',
            }),
        ).toBe(false);
    });

    it('allows Enterprise plans on licensed self-hosted', () => {
        for (const plan of planVariants.enterprise) {
            expect(
                isTeamsOrEnterpriseTierAllowed({
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
                isTeamsOrEnterpriseTierAllowed({
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                    planType: plan,
                }),
            ).toBe(false);
        }
    });

    it('blocks unlicensed self-hosted', () => {
        expect(
            isTeamsOrEnterpriseTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.SELF_HOSTED,
            }),
        ).toBe(false);
    });

    it('allows trial as Teams-cloud preview', () => {
        expect(
            isTeamsOrEnterpriseTierAllowed({
                valid: true,
                subscriptionStatus: SubscriptionStatus.TRIAL,
            }),
        ).toBe(true);
    });

    it('blocks invalid / missing license', () => {
        expect(isTeamsOrEnterpriseTierAllowed(null)).toBe(false);
        expect(isTeamsOrEnterpriseTierAllowed(undefined)).toBe(false);
        expect(
            isTeamsOrEnterpriseTierAllowed({
                valid: false,
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                planType: 'teams_byok',
            }),
        ).toBe(false);
    });

    it('blocks canceled / expired / payment_failed', () => {
        for (const status of [
            SubscriptionStatus.CANCELED,
            SubscriptionStatus.EXPIRED,
            SubscriptionStatus.PAYMENT_FAILED,
        ]) {
            expect(
                isTeamsOrEnterpriseTierAllowed({
                    valid: true,
                    subscriptionStatus: status,
                    planType: 'teams_byok',
                }),
            ).toBe(false);
        }
    });
});

describe('isTeamsOrEnterpriseTierAllowed — self-hosted tiers', () => {
    const selfHosted = (planType: string) => ({
        valid: true,
        subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
        planType,
    });

    it('lets only an Enterprise key through by default', () => {
        expect(isTeamsOrEnterpriseTierAllowed(selfHosted('enterprise'))).toBe(
            true,
        );
        expect(isTeamsOrEnterpriseTierAllowed(selfHosted('teams'))).toBe(false);
        expect(isTeamsOrEnterpriseTierAllowed(selfHosted('teams_byok'))).toBe(
            false,
        );
    });

    it('lets a Teams key through when the feature names it', () => {
        const both = { selfHostedTiers: ['teams', 'enterprise'] as const };

        expect(isTeamsOrEnterpriseTierAllowed(selfHosted('teams'), both)).toBe(
            true,
        );
        expect(
            isTeamsOrEnterpriseTierAllowed(selfHosted('teams_byok'), both),
        ).toBe(true);
        expect(
            isTeamsOrEnterpriseTierAllowed(selfHosted('enterprise'), both),
        ).toBe(true);
        expect(
            isTeamsOrEnterpriseTierAllowed(selfHosted('free_byok'), both),
        ).toBe(false);
    });
});
