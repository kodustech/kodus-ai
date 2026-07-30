import { GetSpendLimitConfigUseCase } from './get-spend-limit-config.use-case';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;

describe('GetSpendLimitConfigUseCase', () => {
    let useCase: GetSpendLimitConfigUseCase;
    let configService: { getConfig: jest.Mock };
    let getOrgByokModels: { execute: jest.Mock };
    let pricingResolver: { resolveMany: jest.Mock };

    beforeEach(() => {
        configService = { getConfig: jest.fn().mockResolvedValue(null) };
        getOrgByokModels = { execute: jest.fn().mockResolvedValue([]) };
        pricingResolver = { resolveMany: jest.fn().mockResolvedValue([]) };
        useCase = new GetSpendLimitConfigUseCase(
            configService as any,
            getOrgByokModels as any,
            pricingResolver as any,
        );
    });

    it('returns safe defaults and priceable=true when nothing is configured', async () => {
        const result = await useCase.execute(ORG);

        expect(result).toEqual({
            enabled: false,
            monthlyLimitUsd: 0,
            modelPricing: {},
            models: [],
            priceable: true,
        });
    });

    it('resolves prices for the org models using the stored overrides', async () => {
        const modelPricing = {
            custom: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 },
        };
        configService.getConfig.mockResolvedValue({
            enabled: true,
            monthlyLimitUsd: 1000,
            modelPricing,
        });
        getOrgByokModels.execute.mockResolvedValue(['gpt-x', 'custom']);
        pricingResolver.resolveMany.mockResolvedValue([
            { model: 'gpt-x', source: 'catalog', priced: true, rates: {} },
            { model: 'custom', source: 'manual', priced: true, rates: {} },
        ]);

        const result = await useCase.execute(ORG);

        expect(pricingResolver.resolveMany).toHaveBeenCalledWith(
            ['gpt-x', 'custom'],
            modelPricing,
        );
        expect(result.enabled).toBe(true);
        expect(result.monthlyLimitUsd).toBe(1000);
        expect(result.modelPricing).toBe(modelPricing);
        expect(result.priceable).toBe(true);
        expect(result.models).toHaveLength(2);
    });

    it('attaches catalog rates (from a catalog-only resolve) for reverting overrides', async () => {
        getOrgByokModels.execute.mockResolvedValue(["custom"]);
        const catalogRates = {
            input: { default: 2e-6 },
            output: { default: 12e-6 },
            cacheRead: { default: 0 },
            cacheWrite: { default: 0 },
        };
        pricingResolver.resolveMany
            // 1st call: with the org's overrides — "custom" is a manual price.
            .mockResolvedValueOnce([
                {
                    model: "custom",
                    source: "manual",
                    priced: true,
                    rates: {
                        input: { default: 5e-6 },
                        output: { default: 9e-6 },
                        cacheRead: { default: 0 },
                        cacheWrite: { default: 0 },
                    },
                },
            ])
            // 2nd call: catalog only — "custom" resolves to its catalog price.
            .mockResolvedValueOnce([
                { model: "custom", source: "catalog", priced: true, rates: catalogRates },
            ]);

        const result = await useCase.execute(ORG);

        expect(result.models[0].source).toBe("manual");
        expect(result.models[0].catalogRates).toEqual(catalogRates);
        expect(pricingResolver.resolveMany).toHaveBeenNthCalledWith(
            1,
            ["custom"],
            undefined,
        );
        expect(pricingResolver.resolveMany).toHaveBeenNthCalledWith(2, [
            "custom",
        ]);
    });

    it('flags priceable=false when any model has no price', async () => {
        getOrgByokModels.execute.mockResolvedValue(['gpt-x', 'mystery']);
        pricingResolver.resolveMany.mockResolvedValue([
            { model: 'gpt-x', source: 'catalog', priced: true, rates: {} },
            { model: 'mystery', source: 'none', priced: false, rates: {} },
        ]);

        const result = await useCase.execute(ORG);

        expect(result.priceable).toBe(false);
    });
});
