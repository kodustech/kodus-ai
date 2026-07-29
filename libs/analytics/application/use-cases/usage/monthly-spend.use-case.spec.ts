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

            expect(result).toMatchObject({
                organizationId: 'org-1',
                periodKey: '2026-06',
                spentUsd: 0,
                byModel: [],
                byCredential: [],
                tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            });
            // No spend ⇒ nothing to extrapolate, whatever the elapsed fraction.
            expect(result.runRate.projectedMonthlyUsd).toBe(0);
            // 2026-06-15T12:30Z is ~48.4% through a 30-day June.
            expect(result.runRate.elapsedFraction).toBeCloseTo(0.484, 3);
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
            // No v2 config supplied ⇒ every model is unattributed, not dropped.
            expect(result.byCredential).toEqual([
                { credentialId: 'unattributed', spentUsd: 3.75 },
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

    describe('getMonthToDateSpend — per-credential rollup', () => {
        const v2Config = {
            version: 2 as const,
            credentials: [
                { id: 'cred-a', provider: 'openai' },
                { id: 'cred-b', provider: 'anthropic' },
            ],
            models: [
                { id: 'mdl-1', credentialId: 'cred-a', model: 'gpt-4o' },
                { id: 'mdl-2', credentialId: 'cred-b', model: 'claude' },
            ],
        };

        it('rolls per-model spend up to credentials via the v2 config map', async () => {
            tokenUsageService.getDailyUsage.mockResolvedValue([
                { input: 1, output: 1, outputReasoning: 0, model: 'gpt-4o' },
            ]);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'gpt-4o', spentUsd: 4 },
                { model: 'claude', spentUsd: 6 },
            ]);

            const result = await useCase.getMonthToDateSpend(
                'org-1',
                NOW,
                undefined,
                v2Config,
            );

            expect(result.byCredential).toEqual([
                { credentialId: 'cred-a', spentUsd: 4 },
                { credentialId: 'cred-b', spentUsd: 6 },
            ]);
            // Total scope is unchanged by the rollup.
            expect(result.spentUsd).toBe(10);
        });

        it('routes spend for an unconfigured model to the unattributed bucket', async () => {
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'gpt-4o', spentUsd: 4 },
                { model: 'removed-model', spentUsd: 2.5 },
            ]);

            const result = await useCase.getMonthToDateSpend(
                'org-1',
                NOW,
                undefined,
                v2Config,
            );

            expect(result.byCredential).toEqual([
                { credentialId: 'cred-a', spentUsd: 4 },
                { credentialId: 'unattributed', spentUsd: 2.5 },
            ]);
        });

        it('attributes a colliding model-name to one credential without throwing (A2 approximation)', async () => {
            // Two credentials configure the SAME model-name — the config schema
            // gate (validateByokConfigRefs) does not forbid this, so the rollup
            // is approximate: all spend for the name lands on the first match.
            const collidingConfig = {
                version: 2 as const,
                credentials: [
                    { id: 'cred-a', provider: 'openai' },
                    { id: 'cred-b', provider: 'openai' },
                ],
                models: [
                    { id: 'mdl-1', credentialId: 'cred-a', model: 'gpt-4o' },
                    { id: 'mdl-2', credentialId: 'cred-b', model: 'gpt-4o' },
                ],
            };
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'gpt-4o', spentUsd: 9 },
            ]);

            const result = await useCase.getMonthToDateSpend(
                'org-1',
                NOW,
                undefined,
                collidingConfig,
            );

            expect(result.byCredential).toEqual([
                { credentialId: 'cred-a', spentUsd: 9 },
            ]);
        });
    });

    describe('getMonthToDateSpend — run-rate projection', () => {
        it('extrapolates spend to a full month at the current pace', async () => {
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 100 },
            ]);

            const result = await useCase.getMonthToDateSpend('org-1', NOW);

            // ~48.4% through June ⇒ ~100 / 0.484 ≈ 206.6.
            expect(result.runRate.elapsedFraction).toBeCloseTo(0.484, 3);
            expect(result.runRate.projectedMonthlyUsd).toBeCloseTo(206.6, 0);
        });

        it('projects 0 at the first instant of the month (no elapsed time)', async () => {
            const monthStart = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'm1', spentUsd: 100 },
            ]);

            const result = await useCase.getMonthToDateSpend(
                'org-1',
                monthStart,
            );

            expect(result.runRate.elapsedFraction).toBe(0);
            expect(result.runRate.projectedMonthlyUsd).toBe(0);
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

            expect(status).toMatchObject({
                organizationId: 'org-1',
                periodKey: '2026-06',
                spentUsd: 75,
                limitUsd: 100,
                pct: 75,
                isOverLimit: false,
                crossedThresholds: [50, 75],
                byModel: [{ model: 'm1', spentUsd: 75 }],
            });
            // The evaluation carries the scope + run-rate readouts too.
            expect(status.byCredential).toEqual([
                { credentialId: 'unattributed', spentUsd: 75 },
            ]);
            expect(status.runRate.projectedMonthlyUsd).toBeGreaterThan(0);
        });

        it('threads the v2 config through to the per-credential readout', async () => {
            tokenUsageService.getDailyUsage.mockResolvedValue([
                { input: 1, output: 1, outputReasoning: 0, model: 'gpt-4o' },
            ]);
            modelCostCalculator.spendByModel.mockResolvedValue([
                { model: 'gpt-4o', spentUsd: 75 },
            ]);
            const v2Config = {
                version: 2 as const,
                credentials: [{ id: 'cred-a', provider: 'openai' }],
                models: [
                    { id: 'mdl-1', credentialId: 'cred-a', model: 'gpt-4o' },
                ],
            };

            const status = await useCase.getStatus(
                'org-1',
                100,
                NOW,
                undefined,
                v2Config,
            );

            expect(status.byCredential).toEqual([
                { credentialId: 'cred-a', spentUsd: 75 },
            ]);
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
