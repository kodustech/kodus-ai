import { MonthlySpendUseCase } from './monthly-spend.use-case';

describe('MonthlySpendUseCase', () => {
    let useCase: MonthlySpendUseCase;
    let tokenUsageService: { getDailyUsage: jest.Mock };
    let modelCostCalculator: { spendByModel: jest.Mock };

    // Mid-month, mid-day UTC — keeps the "month-to-date" window unambiguous.
    const NOW = new Date(Date.UTC(2026, 5, 15, 12, 30, 0)); // 2026-06-15

    beforeEach(() => {
        tokenUsageService = { getDailyUsage: jest.fn().mockResolvedValue([]) };
        modelCostCalculator = { spendByModel: jest.fn().mockResolvedValue([]) };
        useCase = new MonthlySpendUseCase(
            tokenUsageService as any,
            modelCostCalculator as any,
        );
    });

    describe('getMonthToDateSpend', () => {
        it('queries BYOK usage for the current calendar month up to now', async () => {
            await useCase.getMonthToDateSpend('org-1', NOW);

            expect(tokenUsageService.getDailyUsage).toHaveBeenCalledTimes(1);
            const [query] = tokenUsageService.getDailyUsage.mock.calls[0];
            expect(query.organizationId).toBe('org-1');
            expect(query.byok).toBe(true);
            // Window starts at the first instant of the month (UTC)...
            expect(query.start.toISOString()).toBe('2026-06-01T00:00:00.000Z');
            // ...and ends at "now" (month-to-date, not end of month).
            expect(query.end).toBe(NOW);
        });

        it('returns an empty, zeroed result when there is no usage', async () => {
            const result = await useCase.getMonthToDateSpend('org-1', NOW);

            expect(result).toEqual({
                organizationId: 'org-1',
                periodKey: '2026-06',
                spentUsd: 0,
                byModel: [],
                tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            });
        });

        it('sums per-model spend and aggregates token usage across days', async () => {
            const rows = [
                {
                    input: 100,
                    output: 50,
                    outputReasoning: 30,
                    cacheRead: 40,
                    total: 150,
                    model: 'm1',
                    date: '2026-06-01',
                },
                {
                    input: 200,
                    output: 80,
                    outputReasoning: 40,
                    cacheRead: 100,
                    cacheWrite: 10,
                    total: 280,
                    model: 'm2',
                    date: '2026-06-02',
                },
            ];
            tokenUsageService.getDailyUsage.mockResolvedValue(rows);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 1.5 },
                { model: 'm2', spentUsd: 2.25 },
            ]);

            const result = await useCase.getMonthToDateSpend('org-1', NOW);

            // Cost math is delegated to the calculator with the raw rows.
            expect(modelCostCalculator.spendByModel).toHaveBeenCalledWith(
                rows,
                undefined,
            );
            expect(result.spentUsd).toBe(3.75);
            expect(result.byModel).toEqual([
                { model: 'm1', spentUsd: 1.5 },
                { model: 'm2', spentUsd: 2.25 },
            ]);
            expect(result.tokenUsage).toEqual({
                inputTokens: 300,
                outputTokens: 130,
                reasoningTokens: 70,
                // total = input + output only (reasoning already in output)
                totalTokens: 430,
                cacheReadTokens: 140,
                cacheWriteTokens: 10,
            });
        });

        it('rounds total spend to cents', async () => {
            tokenUsageService.getDailyUsage.mockResolvedValue([
                { input: 1, output: 1, outputReasoning: 0, model: 'm1' },
            ]);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 1.005 },
                { model: 'm1', spentUsd: 2.004 },
            ]);

            const result = await useCase.getMonthToDateSpend('org-1', NOW);
            expect(result.spentUsd).toBe(3.01);
        });

        it('forwards manual pricing overrides to the calculator', async () => {
            const rows = [
                { input: 1, output: 1, outputReasoning: 0, model: 'custom' },
            ];
            const overrides = {
                custom: { input: 1e-6, output: 1e-6, cacheRead: 0, cacheWrite: 0 },
            };
            tokenUsageService.getDailyUsage.mockResolvedValue(rows);

            await useCase.getMonthToDateSpend('org-1', NOW, overrides);

            expect(modelCostCalculator.spendByModel).toHaveBeenCalledWith(
                rows,
                overrides,
            );
        });

        it('builds a zero-padded periodKey for single-digit months', async () => {
            const jan = new Date(Date.UTC(2026, 0, 9, 8, 0, 0)); // 2026-01-09
            const result = await useCase.getMonthToDateSpend('org-1', jan);
            expect(result.periodKey).toBe('2026-01');
            const [query] = tokenUsageService.getDailyUsage.mock.calls[0];
            expect(query.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        });
    });

    describe('getStatus', () => {
        it('evaluates month-to-date spend against the limit (the shared seam)', async () => {
            tokenUsageService.getDailyUsage.mockResolvedValue([
                { input: 1, output: 1, outputReasoning: 0, model: 'm1' },
            ]);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 75 },
            ]);

            const status = await useCase.getStatus('org-1', 100, NOW);

            expect(status).toEqual({
                organizationId: 'org-1',
                periodKey: '2026-06',
                spentUsd: 75,
                limitUsd: 100,
                pct: 75,
                isOverLimit: false,
                crossedThresholds: [50, 75],
                byModel: [{ model: 'm1', spentUsd: 75 }],
            });
        });

        it('flags over-limit when spend meets or exceeds the limit', async () => {
            tokenUsageService.getDailyUsage.mockResolvedValue([
                { input: 1, output: 1, outputReasoning: 0, model: 'm1' },
            ]);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 120 },
            ]);

            const status = await useCase.getStatus('org-1', 100, NOW);

            expect(status.isOverLimit).toBe(true);
            expect(status.crossedThresholds).toEqual([50, 75, 90, 100]);
        });
    });
});
