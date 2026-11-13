import { environment } from '@libs/ee/configs/environment';

import {
    customAgentsBlockedBy,
    isCustomAgentsReleaseAllowed,
} from './custom-agents-plan';

jest.mock('@libs/ee/configs/environment', () => {
    const actual = jest.requireActual('@libs/ee/configs/environment');
    return {
        ...actual,
        environment: { ...actual.environment, API_CLOUD_MODE: true },
    };
});

describe('isCustomAgentsReleaseAllowed', () => {
    const betaFeatures = process.env.BETA_FEATURES;

    afterEach(() => {
        environment.API_CLOUD_MODE = true;
        if (betaFeatures === undefined) {
            delete process.env.BETA_FEATURES;
        } else {
            process.env.BETA_FEATURES = betaFeatures;
        }
    });

    // Custom agents are a beta feature of the catalog (#2425).
    it.each([
        ['unset', undefined, false],
        ['false', 'false', false],
        ['an empty value', '', false],
        ['true', 'true', true],
        ['TRUE', ' TRUE ', true],
        ['1', '1', true],
    ])(
        'on a self-hosted install with BETA_FEATURES %s',
        (_name, value, allowed) => {
            environment.API_CLOUD_MODE = false;
            if (value === undefined) {
                delete process.env.BETA_FEATURES;
            } else {
                process.env.BETA_FEATURES = value;
            }

            expect(isCustomAgentsReleaseAllowed()).toBe(allowed);
        },
    );

    // On Cloud the plan alone decides, as before.
    it.each([undefined, 'false', 'true'])(
        'allows Cloud whatever BETA_FEATURES says (%s)',
        (value) => {
            if (value === undefined) {
                delete process.env.BETA_FEATURES;
            } else {
                process.env.BETA_FEATURES = value;
            }

            expect(isCustomAgentsReleaseAllowed()).toBe(true);
        },
    );
});

// What the review's config stage and Try it both ask before running an agent.
describe('customAgentsBlockedBy', () => {
    const betaFeatures = process.env.BETA_FEATURES;
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const license = (planType: string) =>
        ({
            validateOrganizationLicense: jest.fn().mockResolvedValue({
                valid: true,
                subscriptionStatus: 'active',
                planType,
            }),
        }) as any;
    const blockedBy = (planType: string) =>
        customAgentsBlockedBy(license(planType), organizationAndTeamData, 't');

    beforeEach(() => {
        environment.API_CLOUD_MODE = false;
        delete process.env.BETA_FEATURES;
    });

    afterEach(() => {
        environment.API_CLOUD_MODE = true;
        if (betaFeatures === undefined) {
            delete process.env.BETA_FEATURES;
        } else {
            process.env.BETA_FEATURES = betaFeatures;
        }
    });

    it('lets a self-hosted install with BETA_FEATURES=true and a plan that has them run', async () => {
        process.env.BETA_FEATURES = 'true';

        await expect(blockedBy('teams_byok')).resolves.toBeNull();
    });

    it('still asks the plan of a self-hosted install with BETA_FEATURES=true', async () => {
        process.env.BETA_FEATURES = 'true';

        await expect(blockedBy('free_byok')).resolves.toBe('plan');
    });

    it('names the release stage before reading the plan when BETA_FEATURES is off', async () => {
        const licenseService = license('teams_byok');

        await expect(
            customAgentsBlockedBy(licenseService, organizationAndTeamData, 't'),
        ).resolves.toBe('beta');
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });
});
