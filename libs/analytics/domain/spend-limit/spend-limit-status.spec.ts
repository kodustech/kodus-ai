import { buildSpendLimitStatus } from './spend-limit-status';

describe('buildSpendLimitStatus', () => {
    it('reports no crossings well below the first threshold', () => {
        const status = buildSpendLimitStatus(40, 100);

        expect(status).toEqual({
            spentUsd: 40,
            limitUsd: 100,
            pct: 40,
            isOverLimit: false,
            crossedThresholds: [],
        });
    });

    it.each([
        { spent: 50, expected: [50] },
        { spent: 74.99, expected: [50] },
        { spent: 75, expected: [50, 75] },
        { spent: 90, expected: [50, 75, 90] },
        { spent: 99.99, expected: [50, 75, 90] },
    ])(
        'crosses $expected at $spent of a 100 limit (still under limit)',
        ({ spent, expected }) => {
            const status = buildSpendLimitStatus(spent, 100);
            expect(status.crossedThresholds).toEqual(expected);
            expect(status.isOverLimit).toBe(false);
        },
    );

    it('marks over-limit and crosses every threshold exactly at 100%', () => {
        const status = buildSpendLimitStatus(100, 100);

        expect(status.crossedThresholds).toEqual([50, 75, 90, 100]);
        expect(status.isOverLimit).toBe(true);
        expect(status.pct).toBe(100);
    });

    it('stays over-limit past 100% and keeps pct above 100', () => {
        const status = buildSpendLimitStatus(150, 100);

        expect(status.crossedThresholds).toEqual([50, 75, 90, 100]);
        expect(status.isOverLimit).toBe(true);
        expect(status.pct).toBe(150);
    });

    it('treats a non-positive limit as "no usable limit" — never crossed, never over', () => {
        for (const limit of [0, -10, Number.NaN]) {
            const status = buildSpendLimitStatus(500, limit);
            expect(status.pct).toBe(0);
            expect(status.isOverLimit).toBe(false);
            expect(status.crossedThresholds).toEqual([]);
        }
    });

    it('clamps a negative or non-finite spend to zero', () => {
        expect(buildSpendLimitStatus(-5, 100).spentUsd).toBe(0);
        expect(buildSpendLimitStatus(Number.NaN, 100).spentUsd).toBe(0);
        expect(buildSpendLimitStatus(-5, 100).crossedThresholds).toEqual([]);
    });

    it('honors a custom threshold set', () => {
        const status = buildSpendLimitStatus(60, 100, [25, 50, 80]);
        expect(status.crossedThresholds).toEqual([25, 50]);
    });
});
