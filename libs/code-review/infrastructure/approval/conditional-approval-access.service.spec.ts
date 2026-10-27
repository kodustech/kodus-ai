import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { ConditionalApprovalAccessService } from './conditional-approval-access.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ warn: jest.fn() }),
}));

const org = { organizationId: 'org-1', teamId: 'team-1' };
const featureGate = { isEnabled: jest.fn().mockResolvedValue(true) };
const organizationService = {
    getReleaseTrack: jest.fn().mockResolvedValue('beta'),
};
const licenseService = {
    validateOrganizationLicense: jest.fn().mockResolvedValue({
        valid: true,
        planType: 'teams_managed',
        subscriptionStatus: SubscriptionStatus.ACTIVE,
    }),
};
const access = new ConditionalApprovalAccessService(
    featureGate as any,
    organizationService as any,
    licenseService as any,
);
beforeEach(() => {
    jest.clearAllMocks();
    featureGate.isEnabled.mockResolvedValue(true);
    organizationService.getReleaseTrack.mockResolvedValue('beta');
    licenseService.validateOrganizationLicense.mockResolvedValue({
        valid: true,
        planType: 'teams_managed',
        subscriptionStatus: SubscriptionStatus.ACTIVE,
    });
});

it('allows a flagged Teams organization', async () => {
    expect(await access.isEnabled(org)).toBe(true);
    expect(featureGate.isEnabled).toHaveBeenCalledWith(
        'conditional-pr-approval',
        expect.objectContaining({
            identifier: org.organizationId,
            releaseTrack: 'beta',
        }),
    );
});

it.each([
    ['free', 'free_byok', SubscriptionStatus.ACTIVE],
    ['canceled Teams', 'teams_managed', SubscriptionStatus.CANCELED],
])(
    'denies %s after the beta check',
    async (_name, planType, subscriptionStatus) => {
        licenseService.validateOrganizationLicense.mockResolvedValueOnce({
            valid: true,
            planType,
            subscriptionStatus,
        });
        expect(await access.isEnabled(org)).toBe(false);
        expect(featureGate.isEnabled).toHaveBeenCalledTimes(1);
    },
);

it('allows a Teams trial', async () => {
    licenseService.validateOrganizationLicense.mockResolvedValueOnce({
        valid: true,
        planType: 'teams_managed',
        subscriptionStatus: SubscriptionStatus.TRIAL,
    });
    expect(await access.isEnabled(org)).toBe(true);
});

it('fails closed when the flag or license lookup fails', async () => {
    featureGate.isEnabled.mockResolvedValueOnce(false);
    expect(await access.isEnabled(org)).toBe(false);
    expect(licenseService.validateOrganizationLicense).not.toHaveBeenCalled();
    licenseService.validateOrganizationLicense.mockRejectedValueOnce(
        new Error('unavailable'),
    );
    expect(await access.isEnabled(org)).toBe(false);
});
