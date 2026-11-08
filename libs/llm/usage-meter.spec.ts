jest.mock('@libs/core/log/logger', () => {
    const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    return { createLogger: jest.fn(() => logger) };
});

import {
    meteredRequest,
    reportUsage,
    reportUsageFromError,
    runWithUsageMeter,
    type UsageObservation,
} from './usage-meter';

describe('usage meter', () => {
    it('reports every request made inside the metered work', async () => {
        const seen: UsageObservation[] = [];

        await runWithUsageMeter({ record: (o) => seen.push(o) }, async () => {
            reportUsage({ inputTokens: 100, outputTokens: 20 } as any, {
                modelName: 'fireworks:deepseek',
                runName: 'scan-lens',
            });
            await Promise.resolve();
            reportUsage({ inputTokens: 5, outputTokens: 1 } as any, {
                runName: 'scan-lens',
            });
        });

        expect(seen).toHaveLength(2);
        expect(seen[0]).toEqual(
            expect.objectContaining({
                modelName: 'fireworks:deepseek',
                usage: expect.objectContaining({
                    inputTokens: 100,
                    outputTokens: 20,
                }),
            }),
        );
    });

    it('keeps two concurrent metered runs apart', async () => {
        const a: UsageObservation[] = [];
        const b: UsageObservation[] = [];

        await Promise.all([
            runWithUsageMeter({ record: (o) => a.push(o) }, async () => {
                await new Promise((r) => setTimeout(r, 5));
                reportUsage({ inputTokens: 1 } as any, { runName: 'a' });
            }),
            runWithUsageMeter({ record: (o) => b.push(o) }, async () => {
                reportUsage({ inputTokens: 2 } as any, { runName: 'b' });
            }),
        ]);

        expect(a.map((o) => o.runName)).toEqual(['a']);
        expect(b.map((o) => o.runName)).toEqual(['b']);
    });

    it('does nothing outside a metered run', () => {
        expect(() =>
            reportUsage({ inputTokens: 1 } as any, { runName: 'x' }),
        ).not.toThrow();
    });

    it('never lets a failing meter break the call it observes', async () => {
        await expect(
            runWithUsageMeter(
                {
                    record: () => {
                        throw new Error('meter broke');
                    },
                },
                async () => {
                    reportUsage({ inputTokens: 1 } as any, { runName: 'x' });
                    return 'ok';
                },
            ),
        ).resolves.toBe('ok');
    });

    it('reports what a failed parse was billed, carried on the error', async () => {
        const seen: UsageObservation[] = [];
        await runWithUsageMeter({ record: (o) => seen.push(o) }, async () => {
            reportUsageFromError(
                { usage: { inputTokens: 40, outputTokens: 9 } },
                { runName: 'scan-finalize' },
            );
            // A transport failure generated nothing and reports nothing.
            reportUsageFromError(new Error('ECONNRESET'), { runName: 'x' });
        });

        expect(seen).toEqual([
            expect.objectContaining({
                runName: 'scan-finalize',
                usage: expect.objectContaining({
                    inputTokens: 40,
                    outputTokens: 9,
                }),
            }),
        ]);
    });

    it('meters an extra request (a tool repair) whether it succeeds or fails', async () => {
        const seen: UsageObservation[] = [];
        await runWithUsageMeter({ record: (o) => seen.push(o) }, async () => {
            await meteredRequest(
                async () => ({ usage: { inputTokens: 7, outputTokens: 2 } }),
                'fireworks:deepseek',
                'lens-tool-repair',
            );
            await meteredRequest(
                async () => {
                    throw Object.assign(new Error('still invalid'), {
                        usage: { inputTokens: 5, outputTokens: 1 },
                    });
                },
                'fireworks:deepseek',
                'lens-tool-repair',
            ).catch(() => undefined);
        });

        expect(seen.map((o) => o.usage.inputTokens)).toEqual([7, 5]);
    });

    it('logs a failing meter with the context of the work that installed it', async () => {
        const { createLogger } = jest.requireMock(
            '@libs/core/log/logger',
        ) as any;
        const warn = createLogger.mock.results[0].value.warn as jest.Mock;
        warn.mockClear();

        await runWithUsageMeter(
            {
                record: () => {
                    throw new Error('meter broke');
                },
            },
            async () =>
                reportUsage({ inputTokens: 1 } as any, { runName: 'x' }),
            { organizationId: 'org-1', repositoryId: 'repo-1' },
        );

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    repositoryId: 'repo-1',
                    runName: 'x',
                }),
            }),
        );
    });
});
