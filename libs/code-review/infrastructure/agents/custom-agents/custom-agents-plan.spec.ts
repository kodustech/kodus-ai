import { environment } from '@libs/ee/configs/environment';

import { isCustomAgentsReleaseAllowed } from './custom-agents-plan';

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
