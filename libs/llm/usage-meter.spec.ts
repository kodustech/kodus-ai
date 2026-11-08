import { reportUsage, runWithUsageMeter, type UsageObservation } from './usage-meter';

describe('usage meter', () => {
    it('reports every request made inside the metered work', async () => {
        const seen: UsageObservation[] = [];

        await runWithUsageMeter({ record: (o) => seen.push(o) }, async () => {
            reportUsage(
                { inputTokens: 100, outputTokens: 20 } as any,
                { modelName: 'fireworks:deepseek', runName: 'scan-lens' },
            );
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
});
