import { BuildUsageSummaryUseCase } from './build-usage-summary.use-case';
import {
    BaseUsageContract,
    TierUsage,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

const tier = (o: Partial<TierUsage> = {}): TierUsage => ({
    input: 0,
    output: 0,
    total: 0,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...o,
});

/**
 * BuildUsageSummaryUseCase.enrich() is the app-layer that turns the read's
 * per-bracket token counts into US$ via the calculator — the N-tier cost
 * assembly the wire depends on. Exercised through execute().
 */
describe('BuildUsageSummaryUseCase.execute (enrich)', () => {
    const makeUseCase = (
        byModel: BaseUsageContract[],
        rates: Record<string, any>,
    ) => {
        const tokenUsageService = {
            getSummary: jest.fn().mockResolvedValue({
                model: '',
                input: 0,
                output: 0,
                total: 0,
                outputReasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
            }),
            getSummaryByModel: jest.fn().mockResolvedValue(byModel),
        };
        const pricingResolver = {
            resolve: jest.fn(async (model: string) => ({
                model,
                source: 'catalog',
                priced: true,
                rates: rates[model],
            })),
        };
        const cacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
        };
        return new BuildUsageSummaryUseCase(
            tokenUsageService as any,
            pricingResolver as any,
            cacheService as any,
        );
    };

    it('prices a flat (non-tiered) model at the default rate', async () => {
        const useCase = makeUseCase(
            [
                {
                    model: 'flat',
                    input: 1_000_000,
                    output: 400_000,
                    total: 1_400_000,
                    outputReasoning: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                },
            ],
            {
                flat: {
                    input: { default: 2e-6 },
                    output: { default: 10e-6 },
                    cacheRead: { default: 0 },
                    cacheWrite: { default: 0 },
                },
            },
        );

        const report = await useCase.execute({} as any);
        const row = report.byModel[0];

        expect(row.cost.input).toBeCloseTo(1_000_000 * 2e-6, 10);
        expect(row.cost.output).toBeCloseTo(400_000 * 10e-6, 10);
        expect(row.costByTier).toBeUndefined();
        expect(report.totalCost.total).toBeCloseTo(row.cost.total, 10);
    });

    it('prices a 3-bracket model per bracket and aligns costByTier with byTier', async () => {
        const useCase = makeUseCase(
            [
                {
                    model: 'doubao',
                    input: 600_000,
                    output: 0,
                    total: 600_000,
                    outputReasoning: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    byTier: [
                        tier({ input: 100_000, total: 100_000 }),
                        tier({ input: 200_000, total: 200_000 }),
                        tier({ input: 300_000, total: 300_000 }),
                    ],
                },
            ],
            {
                doubao: {
                    input: {
                        default: 1e-6,
                        tiers: [
                            { threshold: 32_000, rate: 2e-6 },
                            { threshold: 128_000, rate: 4e-6 },
                        ],
                    },
                    output: { default: 0 },
                    cacheRead: { default: 0 },
                    cacheWrite: { default: 0 },
                },
            },
        );

        const report = await useCase.execute({} as any);
        const row = report.byModel[0];

        // costByTier is index-aligned with byTier (3 brackets).
        expect(row.costByTier).toHaveLength(3);
        expect(row.costByTier![0].input).toBeCloseTo(100_000 * 1e-6, 10);
        expect(row.costByTier![1].input).toBeCloseTo(200_000 * 2e-6, 10);
        expect(row.costByTier![2].input).toBeCloseTo(300_000 * 4e-6, 10);
        // cost.input is the sum across brackets: 0.10 + 0.40 + 1.20 = 1.70
        expect(row.cost.input).toBeCloseTo(1.7, 10);
    });
});
