import { CockpitReviewAnalyticsService } from './cockpit-review-analytics.service';

const range = {
    organizationId: 'org-1',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
};

// A suggestion the last implementation check could not decide, and that no
// earlier check recorded as applied.
// NULL-safe: suggestions no check has looked at since the column existed carry
// NULL, and must stay in the rate (a bare `= 'unmeasured'` under NOT drops them).
const UNDECIDED =
    /COALESCE\(s\."suggestionImplementationCheckOutcome", ''\) = 'unmeasured'/;

describe('CockpitReviewAnalyticsService — suggestions the check could not decide', () => {
    let ds: { query: jest.Mock };
    let service: CockpitReviewAnalyticsService;

    beforeEach(() => {
        ds = { query: jest.fn().mockResolvedValue([]) };
        service = new CockpitReviewAnalyticsService(ds as any);
    });

    it('keeps them out of the rates of every closed-PR aggregation', async () => {
        await service.getImplementationRateByCategory(range);

        const [sql] = ds.query.mock.calls[0];
        expect(sql).toMatch(UNDECIDED);
        expect(sql).toMatch(
            /AND NOT \(COALESCE\(s\."suggestionImplementationCheckOutcome"/,
        );
    });

    it('keeps them in what is not a rate: feedback votes count every delivered suggestion', async () => {
        await service.getNegativeFeedbackByCategory(range);

        const [sql] = ds.query.mock.calls[0];
        expect(sql).not.toMatch(/AND NOT \(COALESCE/);
    });

    it('counts every trigger of a Kody Rule, but rates it only on what was decided', async () => {
        ds.query.mockResolvedValue([
            {
                rule_id: 'r1',
                triggers: 10,
                rated: 4,
                implemented: 2,
                thumbs_up: 0,
                thumbs_down: 7,
                last_triggered_at: null,
            },
        ]);

        const [row] = await service.getKodyRulesUsage(range);

        const [sql] = ds.query.mock.calls[0];
        expect(sql).not.toMatch(/AND NOT \(COALESCE/);
        expect(sql).toMatch(/AS rated/);
        expect(row).toEqual(
            expect.objectContaining({
                triggers: 10,
                implemented: 2,
                rate: 0.5,
                thumbsDown: 7,
            }),
        );
    });

    it('returns no rate for a week or severity where nothing was decided, instead of 0%', async () => {
        ds.query.mockResolvedValue([
            {
                week_start: '2026-10-05',
                severity: 'critical',
                sent: 0,
                implemented: 0,
                not_measured: 3,
            },
        ]);

        const [week] = await service.getImplementationRateWeekly(range);

        expect(week.rate).toBeNull();
        expect(week.notMeasured).toBe(3);
        expect(week.bySeverity.critical).toBeUndefined();
    });

    it('counts them per week next to the rate instead of inside it', async () => {
        ds.query.mockResolvedValue([
            {
                week_start: '2026-10-05',
                severity: 'high',
                sent: 3,
                implemented: 1,
                not_measured: 2,
            },
            {
                week_start: '2026-10-05',
                severity: 'low',
                sent: 1,
                implemented: 1,
                not_measured: 0,
            },
        ]);

        const rows = await service.getImplementationRateWeekly(range);

        const [sql] = ds.query.mock.calls[0];
        expect(sql).toMatch(/AS not_measured/);
        expect(rows).toEqual([
            {
                weekStart: '2026-10-05',
                sent: 4,
                implemented: 2,
                notMeasured: 2,
                rate: 0.5,
                bySeverity: {
                    high: {
                        sent: 3,
                        implemented: 1,
                        notMeasured: 2,
                        rate: 0.33,
                    },
                    low: { sent: 1, implemented: 1, notMeasured: 0, rate: 1 },
                },
            },
        ]);
    });

    it('lists them under the not_measured filter, and keeps them out of not_implemented', async () => {
        ds.query.mockResolvedValue([{ total: 0 }]);

        await service.searchSuggestions({
            ...range,
            implementationStatus: 'not_measured',
        });
        const [measuredSql] = ds.query.mock.calls[0];
        expect(measuredSql).toMatch(
            /AND \(COALESCE\(s\."suggestionImplementationCheckOutcome", ''\) = 'unmeasured'/,
        );

        ds.query.mockClear();
        await service.searchSuggestions({
            ...range,
            implementationStatus: 'not_implemented',
        });
        const [notImplementedSql] = ds.query.mock.calls[0];
        expect(notImplementedSql).toMatch(
            /AND NOT \(COALESCE\(s\."suggestionImplementationCheckOutcome"/,
        );
    });

    it('tells each listed suggestion whether its last check could not decide', async () => {
        ds.query
            .mockResolvedValueOnce([
                {
                    suggestion_id: 's-1',
                    implementation_status: 'not_implemented',
                    not_measured: true,
                    pull_request_id: 'pr-1',
                    pr_number: 7,
                    comment_id: null,
                },
            ])
            .mockResolvedValueOnce([{ total: 1 }]);

        const page = await service.searchSuggestions(range);

        expect(page.items[0]).toEqual(
            expect.objectContaining({
                suggestionId: 's-1',
                implementationStatus: 'not_implemented',
                notMeasured: true,
            }),
        );
    });
});
