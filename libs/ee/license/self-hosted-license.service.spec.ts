import { SubscriptionStatus } from './interfaces/license.interface';
import { SelfHostedLicenseService } from './self-hosted-license.service';

/**
 * Self-hosted has no Kodus-funded managed trial credits, so credit
 * consumption must always allow — the licensed seat model gates reviews
 * instead. Returning allowed:false here would block self-hosted reviews.
 */
describe('SelfHostedLicenseService.consumeTrialReviewCredit', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const makeService = () =>
        new SelfHostedLicenseService({ findByKey: jest.fn() } as any);

    it('always allows on self-hosted', async () => {
        const result = await makeService().consumeTrialReviewCredit(orgTeam);
        expect(result).toEqual({ allowed: true, reason: 'SELF_HOSTED' });
    });
});

/**
 * The install always validates as an active enterprise license with
 * unlimited seats, regardless of org, DB state or env vars.
 */
describe('SelfHostedLicenseService.validateOrganizationLicense', () => {
    const makeService = () =>
        new SelfHostedLicenseService({ findByKey: jest.fn() } as any);
    const org = (organizationId: string) =>
        ({ organizationId, teamId: `${organizationId}-team` }) as any;

    it('always returns a valid enterprise license with unlimited seats', async () => {
        const svc = makeService();

        for (const orgId of ['org-a', 'org-b']) {
            const result = await svc.validateOrganizationLicense(org(orgId));
            expect(result).toEqual({
                valid: true,
                subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                planType: 'enterprise',
                numberOfLicenses: 0,
            });
        }
    });

    it('never reads the DB or env for a key', async () => {
        const orgParams = { findByKey: jest.fn() };
        const svc = new SelfHostedLicenseService(orgParams as any);

        await svc.validateOrganizationLicense(org('org-a'));

        expect(orgParams.findByKey).not.toHaveBeenCalled();
    });
});
