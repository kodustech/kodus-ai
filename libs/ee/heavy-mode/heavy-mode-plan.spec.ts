import {
    type ILicenseService,
    type OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';

import {
    isHeavyModePlanAllowed,
    isHeavyModeTierAllowed,
} from './heavy-mode-plan';

const license = (
    subscriptionStatus: SubscriptionStatus | undefined,
    planType?: string,
    valid = true,
): OrganizationLicenseValidationResult => ({
    valid,
    subscriptionStatus,
    planType,
});

describe('isHeavyModeTierAllowed', () => {
    it.each([
        [
            'cloud Teams',
            license(SubscriptionStatus.ACTIVE, 'teams_byok_monthly'),
        ],
        [
            'cloud Teams managed',
            license(SubscriptionStatus.ACTIVE, 'teams_managed_annual'),
        ],
        [
            'cloud Enterprise',
            license(SubscriptionStatus.ACTIVE, 'enterprise_byok'),
        ],
        ['a trial', license(SubscriptionStatus.TRIAL, 'teams_managed_monthly')],
        [
            'self-hosted with an Enterprise key',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'enterprise'),
        ],
        [
            'self-hosted with a Teams key',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'teams'),
        ],
        [
            'self-hosted with a Teams key and a period',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'teams_annual'),
        ],
    ])('runs heavy on %s', (_, l) => {
        expect(isHeavyModeTierAllowed(l)).toBe(true);
    });

    it.each([
        ['cloud free', license(SubscriptionStatus.ACTIVE, 'free_byok')],
        ['cloud free on another status', license(undefined, 'free_byok')],
        ['self-hosted without a key', license(undefined, undefined, false)],
        [
            'self-hosted on an expired key',
            license(SubscriptionStatus.EXPIRED, 'enterprise', false),
        ],
        [
            'self-hosted with a free key',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'free_byok'),
        ],
        [
            'a canceled Teams plan',
            license(SubscriptionStatus.CANCELED, 'teams_byok_monthly'),
        ],
        [
            'a Teams plan whose payment failed',
            license(SubscriptionStatus.PAYMENT_FAILED, 'teams_byok_monthly'),
        ],
        [
            'an invalid license',
            license(SubscriptionStatus.ACTIVE, 'teams_byok_monthly', false),
        ],
        ['no license', null],
    ])('runs Balanced on %s', (_, l) => {
        expect(isHeavyModeTierAllowed(l)).toBe(false);
    });
});

describe('isHeavyModePlanAllowed', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const service = (
        validate: ILicenseService['validateOrganizationLicense'],
    ) =>
        ({
            validateOrganizationLicense: validate,
        }) as unknown as ILicenseService;

    it('reads the plan from the license service', async () => {
        const allowed = await isHeavyModePlanAllowed(
            service(async () =>
                license(SubscriptionStatus.ACTIVE, 'teams_byok_monthly'),
            ),
            orgTeam,
            'spec',
        );
        const free = await isHeavyModePlanAllowed(
            service(async () =>
                license(SubscriptionStatus.ACTIVE, 'free_byok'),
            ),
            orgTeam,
            'spec',
        );

        expect([allowed, free]).toEqual([true, false]);
    });

    it('runs Balanced when the plan cannot be read, or there is no license service', async () => {
        const failing = await isHeavyModePlanAllowed(
            service(async () => {
                throw new Error('billing down');
            }),
            orgTeam,
            'spec',
        );
        const none = await isHeavyModePlanAllowed(undefined, orgTeam, 'spec');

        expect([failing, none]).toEqual([false, false]);
    });
});
