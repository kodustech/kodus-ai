import { CostEstimateUseCase } from './cost-estimate.use-case';
import { ModelCostCalculator } from './model-cost-calculator';
import { PricingResolver } from './pricing-resolver';
import { ModelPricingInfo } from './token-pricing.use-case';

type UsageRow = {
    input: number;
    output: number;
    outputReasoning: number;
    cacheRead?: number;
    cacheWrite?: number;
};

/**
 * Helper: build a ModelPricingInfo in per-token units (catalog shape) from
 * "$/1M" scalars so the test reads like the pricing pages.
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
        id: 'gemini-3.1-pro',
        provider: 'google',
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

describe('CostEstimateUseCase', () => {
    let useCase: CostEstimateUseCase;
    let tokenUsageService: { getUsageByPr: jest.Mock };
    let pullRequestsService: { findOne: jest.Mock };
    let tokenPricingUseCase: { execute: jest.Mock };

    beforeEach(() => {
        tokenUsageService = { getUsageByPr: jest.fn() };
        pullRequestsService = { findOne: jest.fn() };
        tokenPricingUseCase = { execute: jest.fn() };
        // Real calculator over the mocked pricing source: cost math is now
        // owned by ModelCostCalculator, so the end-to-end assertions below
        // exercise it through the use case.
        const modelCostCalculator = new ModelCostCalculator(
            new PricingResolver(tokenPricingUseCase as any),
        );
        useCase = new CostEstimateUseCase(
            tokenUsageService as any,
            pullRequestsService as any,
            modelCostCalculator as any,
        );
    });

    describe('aggregateTokenUsage (private)', () => {
        const aggregate = (rows: UsageRow[]) =>
            (useCase as any).aggregateTokenUsage(rows);

        const cases: Array<{
            name: string;
            rows: UsageRow[];
            expected: {
                inputTokens: number;
                outputTokens: number;
                reasoningTokens: number;
                totalTokens: number;
                cacheReadTokens: number;
                cacheWriteTokens: number;
            };
        }> = [
            {
                name: 'empty input',
                rows: [],
                expected: {
                    inputTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            },
            {
                name: 'single row with reasoning',
                rows: [{ input: 100, output: 50, outputReasoning: 30 }],
                expected: {
                    inputTokens: 100,
                    outputTokens: 50,
                    reasoningTokens: 30,
                    // totalTokens MUST NOT include reasoning — output already does (Vercel SDK convention)
                    totalTokens: 150,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            },
            {
                name: 'single row with zero reasoning',
                rows: [{ input: 1_000, output: 500, outputReasoning: 0 }],
                expected: {
                    inputTokens: 1_000,
                    outputTokens: 500,
                    reasoningTokens: 0,
                    totalTokens: 1_500,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            },
            {
                name: 'multiple rows with cache usage',
                rows: [
                    {
                        input: 100,
                        output: 50,
                        outputReasoning: 30,
                        cacheRead: 40,
                    },
                    {
                        input: 200,
                        output: 80,
                        outputReasoning: 40,
                        cacheRead: 100,
                        cacheWrite: 10,
                    },
                    { input: 50, output: 20, outputReasoning: 10 },
                ],
                expected: {
                    inputTokens: 350,
                    outputTokens: 150,
                    reasoningTokens: 80,
                    totalTokens: 500,
                    cacheReadTokens: 140,
                    cacheWriteTokens: 10,
                },
            },
        ];

        it.each(cases)('$name', ({ rows, expected }) => {
            expect(aggregate(rows)).toEqual(expected);
        });

        it('does not double-count reasoning tokens in totalTokens', () => {
            // Regression guard: totalTokens must be input + output only.
            const result = aggregate([
                { input: 1000, output: 800, outputReasoning: 500 },
            ]);
            expect(result.totalTokens).toBe(1800);
            expect(result.totalTokens).not.toBe(2300);
        });
    });

    describe('execute (end-to-end cost math)', () => {
        const buildUsage = (rows: UsageRow[]) =>
            rows.map((r, i) => ({
                ...r,
                total: r.input + r.output,
                model: 'gemini-3.1-pro',
                prNumber: i + 1,
            }));

        beforeEach(() => {
            pullRequestsService.findOne.mockResolvedValue({
                user: { username: 'alice' },
            });
        });

        it('returns zero cost and 1 developer when there is no usage', async () => {
            tokenUsageService.getUsageByPr.mockResolvedValue([]);

            const result = await useCase.execute('org-1');

            expect(result.tokenUsage).toEqual({
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            });
            expect(result.estimatedMonthlyCost).toBe(0);
            expect(result.costPerDeveloper).toBe(0);
            expect(result.developerCount).toBe(1);
            expect(result.periodDays).toBe(14);
            expect(result.projectionDays).toBe(30);
            // With no usage, the pricing catalog should never be consulted.
            expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
        });

        it('prices a workload where calls landed in the >200K tier bucket', async () => {
            // Both rows have byTier with all usage attributed to `gt` (the
            // repository pre-buckets per-call; here we mimic that result).
            const rows = buildUsage([
                {
                    input: 600_000,
                    output: 300_000,
                    outputReasoning: 120_000,
                    cacheRead: 150_000,
                    cacheWrite: 30_000,
                },
                {
                    input: 400_000,
                    output: 200_000,
                    outputReasoning: 80_000,
                    cacheRead: 50_000,
                    cacheWrite: 20_000,
                },
            ]).map((r) => ({
                ...r,
                byTier: [
                    {
                        input: 0,
                        output: 0,
                        total: 0,
                        outputReasoning: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    {
                        input: r.input,
                        output: r.output,
                        total: r.input + r.output,
                        outputReasoning: r.outputReasoning,
                        cacheRead: r.cacheRead ?? 0,
                        cacheWrite: r.cacheWrite ?? 0,
                    },
                ],
            }));
            tokenUsageService.getUsageByPr.mockResolvedValue(rows);
            pullRequestsService.findOne
                .mockResolvedValueOnce({ user: { username: 'alice' } })
                .mockResolvedValueOnce({ user: { username: 'bob' } });
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

            const result = await useCase.execute('org-1');

            expect(result.tokenUsage).toEqual({
                inputTokens: 1_000_000,
                outputTokens: 500_000,
                reasoningTokens: 200_000,
                totalTokens: 1_500_000,
                cacheReadTokens: 200_000,
                cacheWriteTokens: 50_000,
            });

            // 14-day cost in the gt bucket only:
            //   uncachedInput = 1M - 200K = 800K → 800K × $4/M = $3.20
            //   cacheRead     = 200K × $0.40/M = $0.08
            //   cacheWrite    = 50K × $0 (no tier rate → 0) = $0
            //   output        = 500K × $18/M = $9.00
            //   total         = $12.28
            const cost14 = 3.2 + 0.08 + 0 + 9.0;
            const monthly = cost14 * (30 / 14);

            expect(result.estimatedMonthlyCost).toBe(
                Math.round(monthly * 100) / 100,
            );
            expect(result.developerCount).toBe(2);
            expect(result.costPerDeveloper).toBe(
                Math.round((monthly / 2) * 100) / 100,
            );
            expect(tokenPricingUseCase.execute).toHaveBeenCalledWith(
                'gemini-3.1-pro',
            );
        });

        it('prices a small workload at the default rate when no byTier is set', async () => {
            // Flat rows (no byTier) — every call stayed below the tier
            // threshold, so the repo returned them without a tier breakdown.
            tokenUsageService.getUsageByPr.mockResolvedValue(
                buildUsage([
                    { input: 100_000, output: 40_000, outputReasoning: 0 },
                    { input: 50_000, output: 10_000, outputReasoning: 0 },
                ]),
            );
            tokenPricingUseCase.execute.mockResolvedValue(
                pricingFromMillions({
                    inputPerM: 2,
                    outputPerM: 12,
                    inputPerMTier: 4,
                    outputPerMTier: 18,
                }),
            );

            const result = await useCase.execute('org-1');

            // 14-day cost at default tier:
            //   input 150K × $2/M = $0.30
            //   output 50K × $12/M = $0.60
            //   total = $0.90
            const cost14 = 0.3 + 0.6;
            const monthly = cost14 * (30 / 14);

            expect(result.estimatedMonthlyCost).toBe(
                Math.round(monthly * 100) / 100,
            );
        });

        it('sums cost across multiple models independently', async () => {
            tokenUsageService.getUsageByPr.mockResolvedValue([
                {
                    input: 500_000,
                    output: 100_000,
                    outputReasoning: 0,
                    total: 600_000,
                    model: 'gemini-3.1-pro',
                    prNumber: 1,
                    // Tier-aware model with all calls in gt.
                    byTier: [
                    {
                            input: 0,
                            output: 0,
                            total: 0,
                            outputReasoning: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                        },
                    {
                            input: 500_000,
                            output: 100_000,
                            total: 600_000,
                            outputReasoning: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                        },
                ],
                },
                {
                    input: 500_000,
                    output: 100_000,
                    outputReasoning: 0,
                    total: 600_000,
                    model: 'claude-sonnet-4-5',
                    prNumber: 2,
                    // Flat-priced model — no byTier.
                },
            ]);
            tokenPricingUseCase.execute.mockImplementation(
                async (model: string) => {
                    if (model === 'gemini-3.1-pro') {
                        return pricingFromMillions({
                            inputPerM: 2,
                            outputPerM: 12,
                            inputPerMTier: 4,
                            outputPerMTier: 18,
                        });
                    }
                    return pricingFromMillions({
                        inputPerM: 3,
                        outputPerM: 15,
                    });
                },
            );

            const result = await useCase.execute('org-1');

            // Gemini gt bucket: 500K × $4 + 100K × $18 = $2.00 + $1.80 = $3.80
            // Claude (flat):    500K × $3 + 100K × $15 = $1.50 + $1.50 = $3.00
            // Total 14-day = $6.80
            const cost14 = 3.8 + 3.0;
            const monthly = cost14 * (30 / 14);

            expect(result.estimatedMonthlyCost).toBe(
                Math.round(monthly * 100) / 100,
            );
            expect(tokenPricingUseCase.execute).toHaveBeenCalledTimes(2);
        });

        it('counts unique developers only once per username', async () => {
            tokenUsageService.getUsageByPr.mockResolvedValue(
                buildUsage([
                    { input: 100, output: 50, outputReasoning: 0 },
                    { input: 100, output: 50, outputReasoning: 0 },
                    { input: 100, output: 50, outputReasoning: 0 },
                ]),
            );
            pullRequestsService.findOne
                .mockResolvedValueOnce({ user: { username: 'alice' } })
                .mockResolvedValueOnce({ user: { username: 'alice' } })
                .mockResolvedValueOnce({ user: { username: 'bob' } });
            tokenPricingUseCase.execute.mockResolvedValue(
                pricingFromMillions({ inputPerM: 0, outputPerM: 0 }),
            );

            const result = await useCase.execute('org-1');

            expect(result.developerCount).toBe(2);
        });

        it('falls back to developerCount=1 when no developers are resolved', async () => {
            tokenUsageService.getUsageByPr.mockResolvedValue(
                buildUsage([{ input: 1000, output: 500, outputReasoning: 0 }]),
            );
            pullRequestsService.findOne.mockResolvedValue(null);
            tokenPricingUseCase.execute.mockResolvedValue(
                pricingFromMillions({ inputPerM: 1, outputPerM: 1 }),
            );

            const result = await useCase.execute('org-1');

            expect(result.developerCount).toBe(1);
            expect(result.costPerDeveloper).toBe(result.estimatedMonthlyCost);
        });

        it('passes byok=false and a 14-day window to the token-usage service', async () => {
            tokenUsageService.getUsageByPr.mockResolvedValue([]);

            await useCase.execute('org-1');

            expect(tokenUsageService.getUsageByPr).toHaveBeenCalledTimes(1);
            const [call] = tokenUsageService.getUsageByPr.mock.calls[0];
            expect(call.organizationId).toBe('org-1');
            expect(call.byok).toBe(false);
            const diffMs = call.end.getTime() - call.start.getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);
            expect(diffDays).toBeGreaterThan(14);
            expect(diffDays).toBeLessThan(15);
        });
    });
});
