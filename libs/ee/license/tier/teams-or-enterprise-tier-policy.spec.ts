import { SubscriptionStatus } from '../interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from './teams-or-enterprise-tier-policy';

const paymentFailed = (planType: string) => ({
    valid: false,
    subscriptionStatus: SubscriptionStatus.PAYMENT_FAILED,
    planType,
});

describe('isTeamsOrEnterpriseTierAllowed with allowPaymentFailed', () => {
    it('blocks a plan whose payment failed by default, as every paid-team feature did', () => {
        expect(
            isTeamsOrEnterpriseTierAllowed(paymentFailed('teams_byok')),
        ).toBe(false);
    });

    it('keeps a Teams or Enterprise plan whose payment failed when asked to, whatever `valid` says', () => {
        for (const plan of ['teams', 'teams_byok', 'enterprise']) {
            expect(
                isTeamsOrEnterpriseTierAllowed(paymentFailed(plan), {
                    allowPaymentFailed: true,
                }),
            ).toBe(true);
        }
    });

    it('never lets a free plan through because its payment failed', () => {
        expect(
            isTeamsOrEnterpriseTierAllowed(paymentFailed('free_byok'), {
                allowPaymentFailed: true,
            }),
        ).toBe(false);
    });

    it('leaves every other status as it was', () => {
        const opts = { allowPaymentFailed: true };
        expect(
            isTeamsOrEnterpriseTierAllowed(
                {
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.ACTIVE,
                    planType: 'teams',
                },
                opts,
            ),
        ).toBe(true);
        expect(
            isTeamsOrEnterpriseTierAllowed(
                {
                    valid: false,
                    subscriptionStatus: SubscriptionStatus.CANCELED,
                    planType: 'teams',
                },
                opts,
            ),
        ).toBe(false);
    });
});
