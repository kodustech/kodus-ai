import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { SpendLimitConfigService } from './spend-limit-config.service';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));

describe('SpendLimitConfigService', () => {
    let service: SpendLimitConfigService;
    let orgParams: {
        findByKey: jest.Mock;
        createOrUpdateConfig: jest.Mock;
        find: jest.Mock;
    };
    let monthlySpend: { getStatus: jest.Mock };
    let pricingResolver: { resolveMany: jest.Mock };

    beforeEach(() => {
        orgParams = {
            findByKey: jest.fn(),
            createOrUpdateConfig: jest.fn(),
            find: jest.fn(),
        } as any;
        monthlySpend = { getStatus: jest.fn() };
        pricingResolver = { resolveMany: jest.fn() };
        service = new SpendLimitConfigService(
            orgParams as any,
            monthlySpend as any,
            pricingResolver as any,
        );
    });

    describe('getConfig', () => {
        it('returns the parsed config value', async () => {
            const config = { enabled: true, monthlyLimitUsd: 1000 };
            orgParams.findByKey.mockResolvedValue({ configValue: config });

            await expect(service.getConfig(ORG)).resolves.toEqual(config);
            expect(orgParams.findByKey).toHaveBeenCalledWith(
                OrganizationParametersKey.SPEND_LIMIT_CONFIG,
                ORG,
            );
        });

        it('returns null when the parameter is missing', async () => {
            orgParams.findByKey.mockResolvedValue(null);
            await expect(service.getConfig(ORG)).resolves.toBeNull();
        });

        it('returns null when the lookup throws', async () => {
            orgParams.findByKey.mockRejectedValue(new Error('boom'));
            await expect(service.getConfig(ORG)).resolves.toBeNull();
        });
    });

    describe('evaluate', () => {
        it('returns null when no config exists', async () => {
            orgParams.findByKey.mockResolvedValue(null);
            await expect(service.evaluate(ORG, NOW)).resolves.toBeNull();
            expect(monthlySpend.getStatus).not.toHaveBeenCalled();
        });

        it('returns null when the limit is disabled', async () => {
            orgParams.findByKey.mockResolvedValue({
                configValue: { enabled: false, monthlyLimitUsd: 1000 },
            });
            await expect(service.evaluate(ORG, NOW)).resolves.toBeNull();
            expect(monthlySpend.getStatus).not.toHaveBeenCalled();
        });

        it('returns null when the limit is not a positive number', async () => {
            orgParams.findByKey.mockResolvedValue({
                configValue: { enabled: true, monthlyLimitUsd: 0 },
            });
            await expect(service.evaluate(ORG, NOW)).resolves.toBeNull();
            expect(monthlySpend.getStatus).not.toHaveBeenCalled();
        });

        it('evaluates spend against the configured limit and overrides', async () => {
            const modelPricing = {
                custom: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 },
            };
            orgParams.findByKey.mockResolvedValue({
                configValue: {
                    enabled: true,
                    monthlyLimitUsd: 1000,
                    modelPricing,
                },
            });
            const evaluation = { spentUsd: 750, isOverLimit: false };
            monthlySpend.getStatus.mockResolvedValue(evaluation);

            await expect(service.evaluate(ORG, NOW)).resolves.toBe(evaluation);
            expect(monthlySpend.getStatus).toHaveBeenCalledWith(
                'org-1',
                1000,
                NOW,
                modelPricing,
            );
        });
    });

    describe('checkPriceability', () => {
        it('reports priceable when every model resolves to a price', async () => {
            pricingResolver.resolveMany.mockResolvedValue([
                { model: 'a', priced: true },
                { model: 'b', priced: true },
            ]);

            await expect(
                service.checkPriceability(['a', 'b']),
            ).resolves.toEqual({ priceable: true, unpriceable: [] });
        });

        it('lists the models that have no price', async () => {
            pricingResolver.resolveMany.mockResolvedValue([
                { model: 'a', priced: true },
                { model: 'b', priced: false },
                { model: 'c', priced: false },
            ]);

            await expect(
                service.checkPriceability(['a', 'b', 'c']),
            ).resolves.toEqual({
                priceable: false,
                unpriceable: ['b', 'c'],
            });
        });
    });

    describe('listEnabledOrganizations', () => {
        it('returns only orgs with an enabled, positive limit', async () => {
            orgParams.find.mockResolvedValue([
                {
                    organization: { uuid: 'org-a' },
                    configValue: { enabled: true, monthlyLimitUsd: 1000 },
                },
                {
                    organization: { uuid: 'org-b' },
                    configValue: { enabled: false, monthlyLimitUsd: 1000 },
                },
                {
                    organization: { uuid: 'org-c' },
                    configValue: { enabled: true, monthlyLimitUsd: 0 },
                },
                {
                    // missing organization id — skipped
                    configValue: { enabled: true, monthlyLimitUsd: 500 },
                },
            ]);

            const result = await service.listEnabledOrganizations();

            expect(result).toEqual([
                {
                    organizationId: 'org-a',
                    config: { enabled: true, monthlyLimitUsd: 1000 },
                },
            ]);
        });

        it('returns an empty list when the lookup fails', async () => {
            orgParams.find.mockRejectedValue(new Error('db down'));
            await expect(service.listEnabledOrganizations()).resolves.toEqual(
                [],
            );
        });
    });

    describe('loadAndEvaluate', () => {
        it('returns the config alongside the evaluation', async () => {
            const config = {
                enabled: true,
                monthlyLimitUsd: 1000,
                modelPricing: { m: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 } },
            };
            orgParams.findByKey.mockResolvedValue({ configValue: config });
            const evaluation = { spentUsd: 500, periodKey: '2026-06' };
            monthlySpend.getStatus.mockResolvedValue(evaluation);

            await expect(service.loadAndEvaluate(ORG, NOW)).resolves.toEqual({
                config,
                evaluation,
            });
            expect(monthlySpend.getStatus).toHaveBeenCalledWith(
                'org-1',
                1000,
                NOW,
                config.modelPricing,
            );
        });

        it('returns null when the limit is disabled', async () => {
            orgParams.findByKey.mockResolvedValue({
                configValue: { enabled: false, monthlyLimitUsd: 1000 },
            });
            await expect(service.loadAndEvaluate(ORG, NOW)).resolves.toBeNull();
        });
    });

    describe('saveConfig', () => {
        it('persists under the SPEND_LIMIT_CONFIG key', async () => {
            const config = { enabled: true, monthlyLimitUsd: 500 } as any;
            await service.saveConfig(ORG, config);
            expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
                OrganizationParametersKey.SPEND_LIMIT_CONFIG,
                config,
                ORG,
            );
        });
    });
});
