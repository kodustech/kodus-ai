const mockEnvironment = { API_CLOUD_MODE: true };
jest.mock('@libs/ee/configs/environment', () => ({
    environment: {
        get API_CLOUD_MODE() {
            return mockEnvironment.API_CLOUD_MODE;
        },
    },
}));

import { SubscriptionStatus } from '../interfaces/license.interface';
import {
    isByokUsageView,
    ResolveUsageByokViewUseCase,
} from './resolve-usage-byok-view.use-case';

// Mirrors the Token Usage page's bucket choice
// (apps/web/src/features/ee/token-usage/page.tsx), so a CLI call that omits
// `byok` reads the same numbers the page shows.
describe('isByokUsageView', () => {
    it.each([
        [{ subscriptionStatus: SubscriptionStatus.TRIAL }, true],
        [
            {
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                planType: 'teams_byok_monthly',
            },
            true,
        ],
        [
            {
                subscriptionStatus: SubscriptionStatus.ACTIVE,
                planType: 'teams_managed_monthly',
            },
            false,
        ],
        [
            {
                subscriptionStatus: SubscriptionStatus.CANCELED,
                planType: 'teams_byok_monthly',
            },
            false,
        ],
        [{ valid: false }, false],
    ])('cloud license %j → %s', (license, expected) => {
        expect(
            isByokUsageView({
                isCloud: true,
                license: { valid: true, ...license } as any,
                llmSource: null,
            }),
        ).toBe(expected);
    });

    it('cloud without a license reads the managed bucket', () => {
        expect(
            isByokUsageView({ isCloud: true, license: null, llmSource: null }),
        ).toBe(false);
    });

    it.each([
        ['byok', true],
        ['env', false],
        ['none', false],
        [null, false],
    ] as const)('self-hosted LLM source %s → %s', (llmSource, expected) => {
        expect(
            isByokUsageView({
                isCloud: false,
                license: {
                    valid: true,
                    subscriptionStatus: SubscriptionStatus.LICENSED_SELF_HOSTED,
                },
                llmSource,
            }),
        ).toBe(expected);
    });
});

describe('ResolveUsageByokViewUseCase', () => {
    const make = () => {
        const licenseService = {
            validateOrganizationLicense: jest.fn(),
        };
        const getLLMConfigStatusUseCase = { execute: jest.fn() };
        const useCase = new ResolveUsageByokViewUseCase(
            licenseService as any,
            getLLMConfigStatusUseCase as any,
        );
        return { useCase, licenseService, getLLMConfigStatusUseCase };
    };

    afterEach(() => {
        mockEnvironment.API_CLOUD_MODE = true;
    });

    it('reads the license once for parallel requests of the same org', async () => {
        const { useCase, licenseService } = make();
        licenseService.validateOrganizationLicense.mockResolvedValue({
            valid: true,
            subscriptionStatus: 'active',
            planType: 'teams_byok',
        });

        const results = await Promise.all([
            useCase.execute({ organizationId: 'org-1', teamId: 'team-1' }),
            useCase.execute({ organizationId: 'org-1', teamId: 'team-1' }),
            useCase.execute({ organizationId: 'org-1', teamId: 'team-1' }),
        ]);

        expect(results).toEqual([true, true, true]);
        expect(
            licenseService.validateOrganizationLicense,
        ).toHaveBeenCalledTimes(1);
    });

    it('does not keep a failed license read', async () => {
        const { useCase, licenseService } = make();
        licenseService.validateOrganizationLicense
            .mockResolvedValueOnce({ valid: false })
            .mockResolvedValue({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            });

        await expect(
            useCase.execute({ organizationId: 'org-1' }),
        ).resolves.toBe(false);
        await new Promise((resolve) => setImmediate(resolve));
        await expect(
            useCase.execute({ organizationId: 'org-1' }),
        ).resolves.toBe(true);
        expect(
            licenseService.validateOrganizationLicense,
        ).toHaveBeenCalledTimes(2);
    });

    it('cloud reads the license for the given team', async () => {
        const { useCase, licenseService, getLLMConfigStatusUseCase } = make();
        licenseService.validateOrganizationLicense.mockResolvedValue({
            valid: true,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            planType: 'enterprise_byok',
        });

        await expect(
            useCase.execute({ organizationId: 'org-1', teamId: 'team-1' }),
        ).resolves.toBe(true);
        expect(licenseService.validateOrganizationLicense).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
        );
        expect(getLLMConfigStatusUseCase.execute).not.toHaveBeenCalled();
    });

    it('cloud falls back to the managed bucket when billing fails', async () => {
        const { useCase, licenseService } = make();
        licenseService.validateOrganizationLicense.mockRejectedValue(
            new Error('billing down'),
        );

        await expect(
            useCase.execute({ organizationId: 'org-1' }),
        ).resolves.toBe(false);
    });

    it('self-hosted reads the configured LLM source, not the license', async () => {
        mockEnvironment.API_CLOUD_MODE = false;
        const { useCase, licenseService, getLLMConfigStatusUseCase } = make();
        getLLMConfigStatusUseCase.execute.mockResolvedValue({ source: 'env' });

        await expect(
            useCase.execute({ organizationId: 'org-1' }),
        ).resolves.toBe(false);
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });
});
