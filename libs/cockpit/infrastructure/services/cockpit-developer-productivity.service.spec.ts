// Mutation-killing unit tests for the deterministic logic in
// CockpitDeveloperProductivityService: the ISO-date guard, the trend
// computation wired into the highlight endpoints (including the per-endpoint
// direction-of-improvement literal), and the pure row-reshaping performed by
// the deploy-frequency / lead-time / PR-size aggregations. The DataSource is a
// stub whose `query` is fed canned warehouse rows so the reshaping can be
// asserted exactly; CockpitCodeHealthService is inert (`{}`), since none of the
// methods under test touch it.

// The service only needs the ANALYTICS_DATA_SOURCE token from this barrel; the
// real barrel re-exports heavy ingestion services, so stub it to the constant.
jest.mock('@libs/ee/analytics-warehouse', () => ({
    ANALYTICS_DATA_SOURCE: 'analytics',
}));

import { CockpitDeveloperProductivityService } from './cockpit-developer-productivity.service';
import { CockpitRangeQuery } from '../../domain/types';
import { assertIsoDate, computeTrend } from '../../application/date-range.util';

describe('CockpitDeveloperProductivityService (deterministic logic)', () => {
    let ds: { query: jest.Mock };
    let service: CockpitDeveloperProductivityService;

    const Q: CockpitRangeQuery = {
        organizationId: 'org-1',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        ds = { query: jest.fn() };
        service = new CockpitDeveloperProductivityService(ds as any, {} as any);
    });

    // ---------------------------------------------------------------------
    // assertIsoDate (imported helper, also exercised through the service)
    // ---------------------------------------------------------------------
    describe('assertIsoDate', () => {
        it('accepts a well-formed YYYY-MM-DD string (no throw)', () => {
            expect(() =>
                assertIsoDate('2026-06-01', 'startDate'),
            ).not.toThrow();
            expect(() => assertIsoDate('0001-01-01', 'x')).not.toThrow();
        });

        it('rejects strings that are not exactly 4-2-2 digits', () => {
            // single-digit month / day, non-digits, and trailing time all fail.
            expect(() => assertIsoDate('2026-6-01', 'startDate')).toThrow();
            expect(() => assertIsoDate('2026-06-1', 'startDate')).toThrow();
            expect(() => assertIsoDate('abcd-06-01', 'startDate')).toThrow();
            expect(() => assertIsoDate('2026-06-01T00:00:00Z', 'x')).toThrow();
            expect(() => assertIsoDate('', 'x')).toThrow();
            expect(() => assertIsoDate('26-06-01', 'x')).toThrow();
        });

        it('anchors the pattern so extra leading/trailing chars are rejected', () => {
            // ^...$ anchors: an otherwise-valid substring embedded in junk fails.
            expect(() => assertIsoDate('x2026-06-01', 'x')).toThrow();
            expect(() => assertIsoDate('2026-06-01x', 'x')).toThrow();
        });

        it('embeds the label and the offending value in the message', () => {
            expect(() => assertIsoDate('nope', 'endDate')).toThrow(
                'Invalid endDate. Expected YYYY-MM-DD, got "nope"',
            );
        });
    });

    // ---------------------------------------------------------------------
    // computeTrend (imported helper — the direction-sensitive core)
    // ---------------------------------------------------------------------
    describe('computeTrend', () => {
        it('when previous > 0: rounds the percentage change to 2 decimals', () => {
            // (1 - 3) / 3 * 100 = -66.666... -> -66.67 (kills toFixed removal).
            expect(computeTrend(1, 3, 'up')).toEqual({
                percentageChange: -66.67,
                trend: 'worsened',
            });
            expect(computeTrend(1, 3, 'down')).toEqual({
                percentageChange: -66.67,
                trend: 'improved',
            });
        });

        it('previous > 0, no change: percentage 0 and trend unchanged for both directions', () => {
            expect(computeTrend(5, 5, 'up')).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
            expect(computeTrend(5, 5, 'down')).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
        });

        it('direction "up": positive change improves, negative change worsens', () => {
            expect(computeTrend(12, 10, 'up')).toEqual({
                percentageChange: 20,
                trend: 'improved',
            });
            expect(computeTrend(8, 10, 'up')).toEqual({
                percentageChange: -20,
                trend: 'worsened',
            });
        });

        it('direction "down": negative change improves, positive change worsens', () => {
            expect(computeTrend(8, 10, 'down')).toEqual({
                percentageChange: -20,
                trend: 'improved',
            });
            expect(computeTrend(12, 10, 'down')).toEqual({
                percentageChange: 20,
                trend: 'worsened',
            });
        });

        it('previous == 0 boundary with current > 0: jumps to a flat 100%', () => {
            // previous > 0 is false at exactly 0, so the current>0 branch runs.
            expect(computeTrend(5, 0, 'up')).toEqual({
                percentageChange: 100,
                trend: 'improved',
            });
            expect(computeTrend(5, 0, 'down')).toEqual({
                percentageChange: 100,
                trend: 'worsened',
            });
        });

        it('previous == 0 and current == 0: no data -> 0 / unchanged', () => {
            expect(computeTrend(0, 0, 'up')).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
        });
    });

    // ---------------------------------------------------------------------
    // getDeployFrequencyChart — repoFilter branch + row reshaping
    // ---------------------------------------------------------------------
    describe('getDeployFrequencyChart', () => {
        it('throws on a malformed startDate before querying (startDate label first)', async () => {
            await expect(
                service.getDeployFrequencyChart({ ...Q, startDate: 'bad' }),
            ).rejects.toThrow(/Invalid startDate/);
            expect(ds.query).not.toHaveBeenCalled();
        });

        it('validates endDate after startDate (endDate label)', async () => {
            await expect(
                service.getDeployFrequencyChart({ ...Q, endDate: 'bad' }),
            ).rejects.toThrow(/Invalid endDate/);
            expect(ds.query).not.toHaveBeenCalled();
        });

        it('without a repository filter: 3 params and no repo clause in SQL', async () => {
            ds.query.mockResolvedValueOnce([]);
            await service.getDeployFrequencyChart(Q);
            const [sql, params] = ds.query.mock.calls[0];
            expect(params).toEqual(['org-1', '2026-06-01', '2026-06-30']);
            expect(sql).not.toContain('repo_full_name');
        });

        it('with a repository filter: pushes the repo as $4 and adds the clause', async () => {
            ds.query.mockResolvedValueOnce([]);
            await service.getDeployFrequencyChart({ ...Q, repository: 'a/b' });
            const [sql, params] = ds.query.mock.calls[0];
            expect(params).toEqual([
                'org-1',
                '2026-06-01',
                '2026-06-30',
                'a/b',
            ]);
            expect(sql).toContain('AND pr.repo_full_name = $4');
        });

        it('reshapes rows to { weekStart, prCount } coercing pr_count to Number, order preserved', async () => {
            ds.query.mockResolvedValueOnce([
                { week_start: '2026-06-01', pr_count: '5' },
                { week_start: '2026-06-08', pr_count: 2 },
            ]);
            await expect(service.getDeployFrequencyChart(Q)).resolves.toEqual([
                { weekStart: '2026-06-01', prCount: 5 },
                { weekStart: '2026-06-08', prCount: 2 },
            ]);
        });
    });

    // ---------------------------------------------------------------------
    // getDeployFrequencyHighlight — reshaping + computeTrend('up')
    // ---------------------------------------------------------------------
    describe('getDeployFrequencyHighlight', () => {
        it('rounds averagePerWeek to 2 decimals and marks a rise as improved (direction up)', async () => {
            // Promise.all order: current period first, previous second.
            ds.query
                .mockResolvedValueOnce([
                    { total_deployments: 20, avg_per_week: '5.678' },
                ])
                .mockResolvedValueOnce([
                    { total_deployments: 8, avg_per_week: 4 },
                ]);

            const res = await service.getDeployFrequencyHighlight(Q);

            expect(res.currentPeriod).toEqual({
                totalDeployments: 20,
                averagePerWeek: 5.68,
            });
            expect(res.previousPeriod).toEqual({
                totalDeployments: 8,
                averagePerWeek: 4,
            });
            // computeTrend(5.68, 4, 'up') => +42% => improved.
            expect(res.comparison).toEqual({
                percentageChange: computeTrend(5.68, 4, 'up').percentageChange,
                trend: 'improved',
            });
        });

        it('falls back to zeros when a period returns no row and uses ?? 0 for null avg', async () => {
            ds.query
                .mockResolvedValueOnce([]) // current: empty -> {0, 0}
                .mockResolvedValueOnce([
                    { total_deployments: 3, avg_per_week: null },
                ]); // previous: null avg -> 0

            const res = await service.getDeployFrequencyHighlight(Q);
            expect(res.currentPeriod).toEqual({
                totalDeployments: 0,
                averagePerWeek: 0,
            });
            expect(res.previousPeriod).toEqual({
                totalDeployments: 3,
                averagePerWeek: 0,
            });
            // Both averages 0 -> unchanged, 0%.
            expect(res.comparison).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
        });
    });

    // ---------------------------------------------------------------------
    // getLeadTimeChart — minutes rounding + hours derivation
    // ---------------------------------------------------------------------
    describe('getLeadTimeChart', () => {
        it('reshapes to minutes (2dp) and hours = minutes/60 (2dp)', async () => {
            ds.query.mockResolvedValueOnce([
                { week_start: '2026-06-01', lead_time_p75_minutes: '120.5' },
            ]);
            await expect(service.getLeadTimeChart(Q)).resolves.toEqual([
                {
                    weekStart: '2026-06-01',
                    leadTimeP75Minutes: 120.5,
                    // 120.5 / 60 = 2.0083... -> 2.01 (kills the /60 + rounding).
                    leadTimeP75Hours: 2.01,
                },
            ]);
        });

        it('applies ?? 0 to a null percentile', async () => {
            ds.query.mockResolvedValueOnce([
                { week_start: '2026-06-08', lead_time_p75_minutes: null },
            ]);
            await expect(service.getLeadTimeChart(Q)).resolves.toEqual([
                {
                    weekStart: '2026-06-08',
                    leadTimeP75Minutes: 0,
                    leadTimeP75Hours: 0,
                },
            ]);
        });
    });

    // ---------------------------------------------------------------------
    // getLeadTimeHighlight — reshaping + computeTrend('down')
    // ---------------------------------------------------------------------
    describe('getLeadTimeHighlight', () => {
        it('a rise in lead time is worsened (direction down), minutes/hours rounded', async () => {
            ds.query
                .mockResolvedValueOnce([{ p75: '90' }]) // current
                .mockResolvedValueOnce([{ p75: 60 }]); // previous

            const res = await service.getLeadTimeHighlight(Q);
            expect(res.currentPeriod).toEqual({
                leadTimeP75Minutes: 90,
                leadTimeP75Hours: 1.5,
            });
            expect(res.previousPeriod).toEqual({
                leadTimeP75Minutes: 60,
                leadTimeP75Hours: 1,
            });
            // computeTrend(90, 60, 'down'): +50% but down => worsened.
            expect(res.comparison).toEqual({
                percentageChange: 50,
                trend: 'worsened',
            });
        });

        it('a drop in lead time is improved (direction down)', async () => {
            ds.query
                .mockResolvedValueOnce([{ p75: 60 }]) // current
                .mockResolvedValueOnce([{ p75: 90 }]); // previous

            const res = await service.getLeadTimeHighlight(Q);
            // computeTrend(60, 90, 'down'): -33.33% down => improved.
            expect(res.comparison).toEqual({
                percentageChange: -33.33,
                trend: 'improved',
            });
        });

        it('uses ?? 0 when the percentile row is missing', async () => {
            ds.query
                .mockResolvedValueOnce([]) // current -> 0
                .mockResolvedValueOnce([{ p75: null }]); // previous -> 0
            const res = await service.getLeadTimeHighlight(Q);
            expect(res.currentPeriod).toEqual({
                leadTimeP75Minutes: 0,
                leadTimeP75Hours: 0,
            });
            expect(res.previousPeriod).toEqual({
                leadTimeP75Minutes: 0,
                leadTimeP75Hours: 0,
            });
        });
    });

    // ---------------------------------------------------------------------
    // getLeadTimeBreakdown — four-way minute/hour reshaping
    // ---------------------------------------------------------------------
    describe('getLeadTimeBreakdown', () => {
        it('maps every stage to minutes and hours (minutes/60, 2dp)', async () => {
            ds.query.mockResolvedValueOnce([
                {
                    week_start: '2026-06-01',
                    pr_count: '3',
                    coding_time_minutes: '60',
                    pickup_time_minutes: '30',
                    review_time_minutes: '120',
                    total_time_minutes: '210',
                },
            ]);
            await expect(service.getLeadTimeBreakdown(Q)).resolves.toEqual([
                {
                    weekStart: '2026-06-01',
                    prCount: 3,
                    codingTimeMinutes: 60,
                    codingTimeHours: 1,
                    pickupTimeMinutes: 30,
                    pickupTimeHours: 0.5,
                    reviewTimeMinutes: 120,
                    reviewTimeHours: 2,
                    totalTimeMinutes: 210,
                    totalTimeHours: 3.5,
                },
            ]);
        });

        it('applies ?? 0 independently to each null stage', async () => {
            ds.query.mockResolvedValueOnce([
                {
                    week_start: '2026-06-08',
                    pr_count: 1,
                    coding_time_minutes: null,
                    pickup_time_minutes: null,
                    review_time_minutes: null,
                    total_time_minutes: null,
                },
            ]);
            await expect(service.getLeadTimeBreakdown(Q)).resolves.toEqual([
                {
                    weekStart: '2026-06-08',
                    prCount: 1,
                    codingTimeMinutes: 0,
                    codingTimeHours: 0,
                    pickupTimeMinutes: 0,
                    pickupTimeHours: 0,
                    reviewTimeMinutes: 0,
                    reviewTimeHours: 0,
                    totalTimeMinutes: 0,
                    totalTimeHours: 0,
                },
            ]);
        });
    });

    // ---------------------------------------------------------------------
    // getPullRequestSizeHighlight — Number() WITHOUT rounding + trend('down')
    // ---------------------------------------------------------------------
    describe('getPullRequestSizeHighlight', () => {
        it('keeps averagePRSize unrounded and treats a size increase as worsened', async () => {
            ds.query
                .mockResolvedValueOnce([
                    { total_prs: 10, avg_pr_size: '123.456' },
                ]) // current
                .mockResolvedValueOnce([{ total_prs: 5, avg_pr_size: 100 }]); // previous

            const res = await service.getPullRequestSizeHighlight(Q);
            // No toFixed here: the raw numeric value survives.
            expect(res.currentPeriod).toEqual({
                totalPRs: 10,
                averagePRSize: 123.456,
            });
            expect(res.previousPeriod).toEqual({
                totalPRs: 5,
                averagePRSize: 100,
            });
            // computeTrend(123.456, 100, 'down'): +23.46% down => worsened.
            expect(res.comparison).toEqual({
                percentageChange: 23.46,
                trend: 'worsened',
            });
        });

        it('uses ?? 0 for null avg_pr_size and falls back to zeros with no row', async () => {
            ds.query
                .mockResolvedValueOnce([]) // current -> {0,0}
                .mockResolvedValueOnce([{ total_prs: 4, avg_pr_size: null }]); // previous -> 0

            const res = await service.getPullRequestSizeHighlight(Q);
            expect(res.currentPeriod).toEqual({
                totalPRs: 0,
                averagePRSize: 0,
            });
            expect(res.previousPeriod).toEqual({
                totalPRs: 4,
                averagePRSize: 0,
            });
            expect(res.comparison).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
        });
    });

    // ---------------------------------------------------------------------
    // getPullRequestsOpenedVsClosed — ratio rounding + ?? 0 default
    // ---------------------------------------------------------------------
    describe('getPullRequestsOpenedVsClosed', () => {
        it('reshapes counts and rounds ratio to 2 decimals', async () => {
            ds.query.mockResolvedValueOnce([
                {
                    week_start: '2026-06-01',
                    opened_count: '3',
                    closed_count: 2,
                    ratio: '0.666',
                },
            ]);
            await expect(
                service.getPullRequestsOpenedVsClosed(Q),
            ).resolves.toEqual([
                {
                    weekStart: '2026-06-01',
                    openedCount: 3,
                    closedCount: 2,
                    ratio: 0.67,
                },
            ]);
        });

        it('applies ?? 0 to a null ratio', async () => {
            ds.query.mockResolvedValueOnce([
                {
                    week_start: '2026-06-08',
                    opened_count: 0,
                    closed_count: 5,
                    ratio: null,
                },
            ]);
            await expect(
                service.getPullRequestsOpenedVsClosed(Q),
            ).resolves.toEqual([
                {
                    weekStart: '2026-06-08',
                    openedCount: 0,
                    closedCount: 5,
                    ratio: 0,
                },
            ]);
        });
    });
});
