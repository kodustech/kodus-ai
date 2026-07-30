import { ModelCostCalculator } from './model-cost-calculator';
import { PricingResolver } from './pricing-resolver';
import { ModelPricingInfo } from './token-pricing.use-case';
import { TierUsage } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

/**
 * Build a ModelPricingInfo in per-token units (catalog shape) from "$/1M"
 * scalars so the tests read like the public pricing pages.
 */
const pricingFromMillions = (opts: {
    inputPerM: number;
    outputPerM: number;
    cacheReadPerM?: number;
    cacheWritePerM?: number;
    inputPerMTier?: number;
    outputPerMTier?: number;
    cacheReadPerMTier?: number;
    cacheWritePerMTier?: number;
}): ModelPricingInfo => {
    const perToken = (x?: number) =>
        typeof x === 'number' ? x / 1e6 : undefined;
    const withTier = (def: number, tieredPerM?: number) => ({
        default: def,
        ...(tieredPerM !== undefined
            ? { tiers: [{ threshold: 200_000, rate: perToken(tieredPerM) ?? 0 }] }
            : {}),
    });
    return {
        id: 'test-model',
        provider: 'test',
        pricing: {
            input: withTier(perToken(opts.inputPerM) ?? 0, opts.inputPerMTier),
            output: withTier(
                perToken(opts.outputPerM) ?? 0,
                opts.outputPerMTier,
            ),
            cacheRead: withTier(
                perToken(opts.cacheReadPerM) ?? 0,
                opts.cacheReadPerMTier,
            ),
            cacheWrite: withTier(
                perToken(opts.cacheWritePerM) ?? 0,
                opts.cacheWritePerMTier,
            ),
            prompt: perToken(opts.inputPerM) ?? 0,
            completion: perToken(opts.outputPerM) ?? 0,
            internal_reasoning: perToken(opts.outputPerM) ?? 0,
        },
    };
};

const tier = (overrides: Partial<TierUsage> = {}): TierUsage => ({
    input: 0,
    output: 0,
    total: 0,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
});

describe('ModelCostCalculator', () => {
    let calculator: ModelCostCalculator;
    let tokenPricingUseCase: { execute: jest.Mock };

    beforeEach(() => {
        tokenPricingUseCase = { execute: jest.fn() };
        // Real resolver over the mocked catalog: the catalog path still flows
        // through tokenPricingUseCase.execute, so the assertions below hold.
        const pricingResolver = new PricingResolver(tokenPricingUseCase as any);
        calculator = new ModelCostCalculator(pricingResolver);
    });

    it('returns zero and never consults pricing for an empty row set', async () => {
        expect(await calculator.totalCost([])).toBe(0);
        expect(await calculator.spendByModel([])).toEqual([]);
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });

    it('prices a flat row at default rates (no byTier present)', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(
            pricingFromMillions({
                inputPerM: 2,
                outputPerM: 12,
                inputPerMTier: 4,
                outputPerMTier: 18,
            }),
        );

        const byModel = await calculator.spendByModel([
            { input: 100_000, output: 40_000, outputReasoning: 0, model: 'g' },
        ]);

        // No byTier → entire row priced at `default`:
        //   input 100K × $2/M = $0.20, output 40K × $12/M = $0.48 → $0.68
        expect(byModel).toHaveLength(1);
        expect(byModel[0].model).toBe('g');
        expect(byModel[0].spentUsd).toBeCloseTo(0.68, 10);
        expect(tokenPricingUseCase.execute).toHaveBeenCalledWith('g');
    });

    it('prices each tier bucket independently when byTier is set', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(
            pricingFromMillions({
                inputPerM: 2,
                outputPerM: 12,
                cacheReadPerM: 0.2,
                inputPerMTier: 4,
                outputPerMTier: 18,
                cacheReadPerMTier: 0.4,
            }),
        );

        const total = await calculator.totalCost([
            {
                input: 1_000_000,
                output: 500_000,
                outputReasoning: 0,
                cacheRead: 200_000,
                cacheWrite: 50_000,
                model: 'g',
                byTier: [tier({
                        input: 200_000,
                        output: 100_000,
                        cacheRead: 50_000,
                        cacheWrite: 20_000,
                    }), tier({
                        input: 800_000,
                        output: 400_000,
                        cacheRead: 150_000,
                        cacheWrite: 30_000,
                    })],
            },
        ]);

        // le bucket at default rates:
        //   uncached 150K × $2/M = $0.30
        //   cacheRead 50K × $0.20/M = $0.01
        //   cacheWrite 20K × $0 = $0
        //   output 100K × $12/M = $1.20
        //   le subtotal = $1.51
        // gt bucket at tier rates:
        //   uncached 650K × $4/M = $2.60
        //   cacheRead 150K × $0.40/M = $0.06
        //   cacheWrite 30K × $0 (no tier rate → 0) = $0
        //   output 400K × $18/M = $7.20
        //   gt subtotal = $9.86
        // total = $11.37
        expect(total).toBeCloseTo(11.37, 10);
    });

    it('falls back to default rates when a tier rate is missing on a non-tiered field', async () => {
        // cacheWrite has no `tier` rate in the catalog — gt bucket should fall
        // back to `default` for cacheWrite rather than charge $0.
        tokenPricingUseCase.execute.mockResolvedValue(
            pricingFromMillions({
                inputPerM: 2,
                outputPerM: 12,
                cacheWritePerM: 2.5,
                inputPerMTier: 4,
                outputPerMTier: 18,
            }),
        );

        const total = await calculator.totalCost([
            {
                input: 300_000,
                output: 0,
                outputReasoning: 0,
                cacheWrite: 100_000,
                model: 'g',
                byTier: [tier(), tier({ input: 300_000, cacheWrite: 100_000 })],
            },
        ]);

        // gt bucket:
        //   input 300K × $4/M (tier rate) = $1.20
        //   cacheWrite 100K × $2.5/M (no tier rate → fallback to default) = $0.25
        //   total = $1.45
        expect(total).toBeCloseTo(1.45, 10);
    });

    it('prices a 3-bracket (multi-tier) model at each bracket rate', async () => {
        // Doubao-style: default + two tiers. byTier[0]=default, [1]=first
        // tier, [2]=second tier.
        tokenPricingUseCase.execute.mockResolvedValue({
            id: 'doubao',
            provider: 'test',
            pricing: {
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
                prompt: 1e-6,
                completion: 0,
                internal_reasoning: 0,
            },
        });

        const total = await calculator.totalCost([
            {
                input: 600_000,
                output: 0,
                outputReasoning: 0,
                model: 'doubao',
                byTier: [
                    tier({ input: 100_000 }), // default rate 1e-6
                    tier({ input: 200_000 }), // tier 1 rate 2e-6
                    tier({ input: 300_000 }), // tier 2 rate 4e-6
                ],
            },
        ]);

        // 100K×1 + 200K×2 + 300K×4 (per-M) = 0.10 + 0.40 + 1.20 = 1.70
        expect(total).toBeCloseTo(1.7, 10);
    });

    it('prices each model independently and consults pricing once per model', async () => {
        tokenPricingUseCase.execute.mockImplementation(async (model: string) =>
            model === 'gemini'
                ? pricingFromMillions({
                      inputPerM: 2,
                      outputPerM: 12,
                      inputPerMTier: 4,
                      outputPerMTier: 18,
                  })
                : pricingFromMillions({ inputPerM: 3, outputPerM: 15 }),
        );

        const byModel = await calculator.spendByModel([
            {
                input: 500_000,
                output: 100_000,
                outputReasoning: 0,
                model: 'gemini',
                byTier: [tier(), tier({ input: 500_000, output: 100_000 })],
            },
            {
                input: 500_000,
                output: 100_000,
                outputReasoning: 0,
                model: 'claude',
            },
        ]);

        const spend = Object.fromEntries(
            byModel.map((m) => [m.model, m.spentUsd]),
        );
        // gemini gt bucket: 500K × $4 + 100K × $18 = $2.00 + $1.80 = $3.80
        // claude (flat):     500K × $3 + 100K × $15 = $1.50 + $1.50 = $3.00
        expect(spend.gemini).toBeCloseTo(3.8, 10);
        expect(spend.claude).toBeCloseTo(3.0, 10);
        expect(tokenPricingUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('prices with a manual override instead of the catalog when one is given', async () => {
        const byModel = await calculator.spendByModel(
            [
                {
                    input: 100_000,
                    output: 40_000,
                    outputReasoning: 0,
                    model: 'custom',
                },
            ],
            {
                custom: {
                    input: 3e-6, // $3 / 1M
                    output: 15e-6, // $15 / 1M
                    cacheRead: 0,
                    cacheWrite: 0,
                },
            },
        );

        // input 100K × $3/M = $0.30, output 40K × $15/M = $0.60 → $0.90
        expect(byModel[0].spentUsd).toBeCloseTo(0.9, 10);
        // Manual override short-circuits the catalog entirely.
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });

    it('contributes zero and skips pricing for usage with a blank/unknown model', async () => {
        const byModel = await calculator.spendByModel([
            { input: 1_000, output: 500, outputReasoning: 0, model: '  ' },
            { input: 1_000, output: 500, outputReasoning: 0 },
        ]);

        expect(byModel).toEqual([{ model: '(unknown)', spentUsd: 0 }]);
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });
});
