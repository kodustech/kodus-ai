import { PricingResolver } from './pricing-resolver';
import { ModelPricingInfo } from './token-pricing.use-case';

const catalogPricing = (opts: {
    inputPerM: number;
    outputPerM: number;
    cacheReadPerM?: number;
    inputPerMTier?: number;
}): ModelPricingInfo => {
    const perToken = (x?: number) => (typeof x === 'number' ? x / 1e6 : 0);
    return {
        id: 'catalog-model',
        provider: 'test',
        pricing: {
            input: {
                default: perToken(opts.inputPerM),
                ...(opts.inputPerMTier !== undefined && {
                    tiers: [
                        {
                            threshold: 200_000,
                            rate: perToken(opts.inputPerMTier),
                        },
                    ],
                }),
            },
            output: { default: perToken(opts.outputPerM) },
            cacheRead: { default: perToken(opts.cacheReadPerM) },
            cacheWrite: { default: 0 },
            prompt: perToken(opts.inputPerM),
            completion: perToken(opts.outputPerM),
            internal_reasoning: perToken(opts.outputPerM),
        },
    };
};

// LiteLLM returns an all-zero ModelPricingInfo for an unknown model.
const emptyCatalogPricing = (): ModelPricingInfo => ({
    id: 'unknown',
    pricing: {
        input: { default: 0 },
        output: { default: 0 },
        cacheRead: { default: 0 },
        cacheWrite: { default: 0 },
        prompt: 0,
        completion: 0,
        internal_reasoning: 0,
    },
});

describe('PricingResolver', () => {
    let resolver: PricingResolver;
    let tokenPricingUseCase: { execute: jest.Mock };

    beforeEach(() => {
        tokenPricingUseCase = { execute: jest.fn() };
        resolver = new PricingResolver(tokenPricingUseCase as any);
    });

    it('prefers a manual override and never consults the catalog', async () => {
        const resolved = await resolver.resolve('custom-model', {
            'custom-model': {
                input: 2e-6,
                output: 12e-6,
                cacheRead: 0.2e-6,
                cacheWrite: 0,
            },
        });

        expect(resolved.source).toBe('manual');
        expect(resolved.priced).toBe(true);
        expect(resolved.rates).toEqual({
            input: { default: 2e-6 },
            output: { default: 12e-6 },
            cacheRead: { default: 0.2e-6 },
            cacheWrite: { default: 0 },
        });
        // Manual pricing is flat — no tiered rate.
        expect(resolved.rates.input.tiers).toBeUndefined();
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });

    it('falls back to the catalog when there is no override, preserving tiers', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(
            catalogPricing({
                inputPerM: 2,
                outputPerM: 12,
                cacheReadPerM: 0.2,
                inputPerMTier: 4,
            }),
        );

        const resolved = await resolver.resolve('gemini-3.1-pro');

        expect(resolved.source).toBe('catalog');
        expect(resolved.priced).toBe(true);
        expect(resolved.rates.input).toEqual({
            default: 2e-6,
            tiers: [{ threshold: 200_000, rate: 4e-6 }],
        });
        expect(resolved.rates.output).toEqual({ default: 12e-6 });
        expect(tokenPricingUseCase.execute).toHaveBeenCalledWith('gemini-3.1-pro');
    });

    it('reports unpriceable when the catalog has no price for the model', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(emptyCatalogPricing());

        const resolved = await resolver.resolve('mystery-model');

        expect(resolved.source).toBe('none');
        expect(resolved.priced).toBe(false);
    });

    it('does not treat an empty/whitespace override as a manual price', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(emptyCatalogPricing());

        const resolved = await resolver.resolve('mystery-model', {
            'some-other-model': {
                input: 1e-6,
                output: 1e-6,
                cacheRead: 0,
                cacheWrite: 0,
            },
        });

        expect(resolved.source).toBe('none');
        expect(tokenPricingUseCase.execute).toHaveBeenCalledWith('mystery-model');
    });

    describe('resolveMany', () => {
        it('resolves and de-duplicates a mixed set of models', async () => {
            tokenPricingUseCase.execute.mockImplementation(
                async (model: string) =>
                    model === 'gemini'
                        ? catalogPricing({ inputPerM: 2, outputPerM: 12 })
                        : emptyCatalogPricing(),
            );

            const results = await resolver.resolveMany(
                ['gemini', 'gemini', 'custom', 'mystery', ''],
                {
                    custom: {
                        input: 5e-6,
                        output: 9e-6,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                },
            );

            const bySource = Object.fromEntries(
                results.map((r) => [r.model, r.source]),
            );
            expect(bySource).toEqual({
                gemini: 'catalog',
                custom: 'manual',
                mystery: 'none',
            });
            // 'gemini' de-duplicated → catalog consulted once for it; 'custom'
            // skips the catalog (manual); blank model is dropped.
            expect(tokenPricingUseCase.execute).toHaveBeenCalledTimes(2);
        });
    });
});
