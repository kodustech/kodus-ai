// Mutation-killing unit tests for the deterministic logic in
// CockpitReviewAnalyticsService: the `round`/`rate` numeric helpers and the
// row-reshaping performed by the three implementation-rate aggregations
// (weekly, by-category, by-severity). The DataSource is a stub whose `query`
// is fed canned warehouse rows so the pure reshaping can be asserted exactly.

// The service only needs the ANALYTICS_DATA_SOURCE token from this barrel; the
// real barrel re-exports heavy ingestion services, so stub it to the constant.
jest.mock('@libs/ee/analytics-warehouse', () => ({
    ANALYTICS_DATA_SOURCE: 'analytics',
}));

import { CockpitReviewAnalyticsService } from './cockpit-review-analytics.service';
import { CockpitRangeQuery } from '../../domain/types';

describe('CockpitReviewAnalyticsService (deterministic logic)', () => {
    let ds: { query: jest.Mock };
    let service: CockpitReviewAnalyticsService;

    const Q: CockpitRangeQuery = {
        organizationId: 'org-1',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        ds = { query: jest.fn() };
        service = new CockpitReviewAnalyticsService(ds as any);
    });

    // Reach the private helpers directly.
    const round = (v: unknown) => (service as any).round(v);
    const rate = (sent: number, implemented: number) =>
        (service as any).rate(sent, implemented);

    describe('round', () => {
        it('rounds to exactly two decimals (half-up at the 3rd place)', () => {
            // 1.234 -> "1.23"; distinguishes toFixed(2) from toFixed(0)/(1)/(3).
            expect(round(1.234)).toBe(1.23);
            expect(round(1.236)).toBe(1.24);
            expect(round(0.124)).toBe(0.12);
            expect(round(0.126)).toBe(0.13);
        });

        it('coerces string input via Number before rounding', () => {
            expect(round('3.456')).toBe(3.46);
            expect(round('2.5')).toBe(2.5);
        });

        it('returns a number, not the toFixed string', () => {
            expect(typeof round(1.5)).toBe('number');
            expect(round(1.5)).toBe(1.5);
        });

        it('uses ?? so null and undefined fall back to 0', () => {
            expect(round(null)).toBe(0);
            expect(round(undefined)).toBe(0);
        });

        it('preserves NaN (?? not ||): NaN is not nullish so it is kept', () => {
            // With `|| 0` this would coerce to 0; with `?? 0` it stays NaN.
            expect(Number.isNaN(round(NaN))).toBe(true);
        });

        it('leaves an exact integer untouched', () => {
            expect(round(7)).toBe(7);
            expect(round(0)).toBe(0);
        });
    });

    describe('rate', () => {
        it('returns 0 when sent is exactly 0 (guards divide-by-zero)', () => {
            expect(rate(0, 5)).toBe(0);
            expect(rate(0, 0)).toBe(0);
        });

        it('divides implemented by sent (not the reverse) and rounds', () => {
            // 1/3 -> 0.33 proves order (reverse would be 3) and 2-decimal round.
            expect(rate(3, 1)).toBe(0.33);
            expect(rate(4, 1)).toBe(0.25);
            expect(rate(2, 1)).toBe(0.5);
        });

        it('does not treat sent=1 as the zero case (=== 0 boundary)', () => {
            expect(rate(1, 1)).toBe(1);
            expect(rate(1, 0)).toBe(0);
        });
    });

    describe('getImplementationRateWeekly (row reshaping)', () => {
        it('groups by week, sums totals, keys bySeverity, and derives rates', async () => {
            ds.query.mockResolvedValueOnce([
                // strings on purpose: exercises the Number() coercion of counters
                {
                    week_start: '2026-06-01',
                    severity: 'critical',
                    sent: '4',
                    implemented: '1',
                },
                {
                    week_start: '2026-06-01',
                    severity: 'high',
                    sent: 2,
                    implemented: 2,
                },
                {
                    week_start: '2026-06-08',
                    severity: 'low',
                    sent: 5,
                    implemented: 0,
                },
            ]);

            const out = await service.getImplementationRateWeekly(Q);

            expect(out).toEqual([
                {
                    weekStart: '2026-06-01',
                    sent: 6, // 4 + 2, numeric (not "04"/"42" string concat)
                    implemented: 3, // 1 + 2
                    rate: 0.5, // rate(6,3) from summed totals, not per-row/0
                    bySeverity: {
                        critical: { sent: 4, implemented: 1, rate: 0.25 },
                        high: { sent: 2, implemented: 2, rate: 1 },
                    },
                },
                {
                    weekStart: '2026-06-08',
                    sent: 5,
                    implemented: 0,
                    rate: 0, // rate(5,0)
                    bySeverity: {
                        low: { sent: 5, implemented: 0, rate: 0 },
                    },
                },
            ]);
        });

        it('preserves first-seen week order from the query rows', async () => {
            ds.query.mockResolvedValueOnce([
                {
                    week_start: '2026-06-15',
                    severity: 'medium',
                    sent: 1,
                    implemented: 1,
                },
                {
                    week_start: '2026-06-01',
                    severity: 'low',
                    sent: 1,
                    implemented: 0,
                },
            ]);

            const out = await service.getImplementationRateWeekly(Q);

            expect(out.map((w) => w.weekStart)).toEqual([
                '2026-06-15',
                '2026-06-01',
            ]);
        });

        it('returns an empty array when there are no rows', async () => {
            ds.query.mockResolvedValueOnce([]);
            expect(await service.getImplementationRateWeekly(Q)).toEqual([]);
        });
    });

    describe('getImplementationRateByCategory (row reshaping)', () => {
        it('maps each row with numeric counters, derived rate, and preserved order', async () => {
            ds.query.mockResolvedValueOnce([
                { category: 'security', sent: '10', implemented: '5' },
                { category: 'Unknown', sent: 0, implemented: 0 },
            ]);

            const out = await service.getImplementationRateByCategory(Q);

            expect(out).toEqual([
                { category: 'security', sent: 10, implemented: 5, rate: 0.5 },
                { category: 'Unknown', sent: 0, implemented: 0, rate: 0 },
            ]);
        });
    });

    describe('getImplementationRateBySeverity (row reshaping)', () => {
        it('maps full and native counters into distinct rates', async () => {
            ds.query.mockResolvedValueOnce([
                // rate (2/8=0.25) differs from nativeRate (3/4=0.75): proves the
                // native fields are not swapped with the full population fields.
                {
                    severity: 'critical',
                    sent: '8',
                    implemented: '2',
                    native_sent: '4',
                    native_implemented: '3',
                },
                {
                    severity: 'low',
                    sent: 2,
                    implemented: 1,
                    native_sent: 0,
                    native_implemented: 0,
                },
            ]);

            const out = await service.getImplementationRateBySeverity(Q);

            expect(out).toEqual([
                {
                    severity: 'critical',
                    sent: 8,
                    implemented: 2,
                    rate: 0.25,
                    nativeSent: 4,
                    nativeImplemented: 3,
                    nativeRate: 0.75,
                },
                {
                    severity: 'low',
                    sent: 2,
                    implemented: 1,
                    rate: 0.5,
                    nativeSent: 0,
                    nativeImplemented: 0,
                    nativeRate: 0, // native_sent=0 -> rate guard returns 0
                },
            ]);
        });
    });
});
