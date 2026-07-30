import { DataSource } from 'typeorm';

import { CockpitReviewAnalyticsService } from '@libs/cockpit/infrastructure/services/cockpit-review-analytics.service';
import { CockpitRangeQuery } from '@libs/cockpit/domain/types';

describe('CockpitReviewAnalyticsService', () => {
    let service: CockpitReviewAnalyticsService;
    let query: jest.Mock;

    const baseQuery: CockpitRangeQuery = {
        organizationId: 'org-1',
        startDate: '2026-03-01',
        endDate: '2026-06-01',
    };

    beforeEach(() => {
        query = jest.fn().mockResolvedValue([]);
        service = new CockpitReviewAnalyticsService(
            {
                query,
            } as unknown as DataSource,
        );
    });

    describe('getImplementationRateWeekly', () => {
        it('composes per-week rows with overall totals and severity breakdown', async () => {
            query.mockResolvedValue([
                { week_start: '2026-05-04', severity: 'critical', sent: 10, implemented: 7 },
                { week_start: '2026-05-04', severity: 'low', sent: 30, implemented: 3 },
                { week_start: '2026-05-11', severity: 'critical', sent: 4, implemented: 2 },
            ]);

            const rows = await service.getImplementationRateWeekly(baseQuery);

            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual({
                weekStart: '2026-05-04',
                sent: 40,
                implemented: 10,
                rate: 0.25,
                bySeverity: {
                    critical: { sent: 10, implemented: 7, rate: 0.7 },
                    low: { sent: 30, implemented: 3, rate: 0.1 },
                },
            });
            expect(rows[1].rate).toBe(0.5);
        });

        it('scopes by org, closed PRs and sent suggestions', async () => {
            await service.getImplementationRateWeekly(baseQuery);

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain(`pr."organizationId" = $1`);
            expect(sql).toContain(`pr."status" = 'closed'`);
            expect(sql).toContain(`s."suggestionDeliveryStatus" = 'sent'`);
            expect(params).toEqual(['org-1', '2026-03-01', '2026-06-01']);
        });

        it('appends the repository filter when provided', async () => {
            await service.getImplementationRateWeekly({
                ...baseQuery,
                repository: 'org/repo',
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('pr.repo_full_name = $4');
            expect(params[3]).toBe('org/repo');
        });
    });

    describe('getImplementationRateByCategory', () => {
        it('maps rows and derives the rate', async () => {
            query.mockResolvedValue([
                { category: 'Security', sent: 48, implemented: 31 },
                { category: 'Code Style', sent: 25, implemented: 4 },
            ]);

            const rows =
                await service.getImplementationRateByCategory(baseQuery);

            expect(rows).toEqual([
                { category: 'Security', sent: 48, implemented: 31, rate: 0.65 },
                { category: 'Code Style', sent: 25, implemented: 4, rate: 0.16 },
            ]);
        });
    });

    describe('getImplementationRateBySeverity', () => {
        it('orders critical-first and maps both full and native rates', async () => {
            query.mockResolvedValue([
                {
                    severity: 'critical',
                    sent: 10,
                    implemented: 7,
                    native_sent: 6,
                    native_implemented: 3,
                },
                {
                    severity: 'medium',
                    sent: 86,
                    implemented: 45,
                    native_sent: 9,
                    native_implemented: 2,
                },
            ]);

            const rows =
                await service.getImplementationRateBySeverity(baseQuery);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain(`WHEN 'critical' THEN 0`);
            // native columns exclude rule-driven suggestions
            expect(sql).toContain(`s."brokenKodyRulesIds" IS NOT NULL`);
            expect(sql).toContain(`lower(s."label") = 'kody_rules'`);
            expect(rows[0]).toEqual({
                severity: 'critical',
                sent: 10,
                implemented: 7,
                rate: 0.7,
                nativeSent: 6,
                nativeImplemented: 3,
                nativeRate: 0.5,
            });
            // medium: full 0.52 inflated by rules; native is 0.22
            expect(rows[1].rate).toBe(0.52);
            expect(rows[1].nativeRate).toBe(0.22);
        });
    });

    describe('getIgnoredCriticals', () => {
        it('returns zero count for empty result sets', async () => {
            const res = await service.getIgnoredCriticals(baseQuery);
            expect(res).toEqual({ count: 0, items: [] });
        });

        it('uses the window total and maps items', async () => {
            query.mockResolvedValue([
                {
                    suggestion_id: 'sg-1',
                    repository: 'org/repo',
                    file_path: 'src/a.ts',
                    category: 'security',
                    summary: 'SQL injection risk',
                    pull_request_id: 'pr-1',
                    pr_number: 1241,
                    pr_closed_at: '2026-05-20T10:00:00Z',
                    total: 12,
                },
            ]);

            const res = await service.getIgnoredCriticals(baseQuery);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain(`lower(s."severity") = 'critical'`);
            expect(res.count).toBe(12);
            expect(res.items[0]).toEqual({
                suggestionId: 'sg-1',
                repository: 'org/repo',
                filePath: 'src/a.ts',
                category: 'security',
                summary: 'SQL injection risk',
                pullRequestId: 'pr-1',
                prNumber: 1241,
                prClosedAt: '2026-05-20T10:00:00Z',
            });
        });
    });

    describe('getKodyRulesUsage', () => {
        it('unnests rule ids and maps usage rows with feedback', async () => {
            query.mockResolvedValue([
                {
                    rule_id: 'rule-1',
                    triggers: 87,
                    implemented: 16,
                    thumbs_up: 2,
                    thumbs_down: 14,
                    last_triggered_at: '2026-05-22T10:00:00Z',
                },
            ]);

            const rows = await service.getKodyRulesUsage(baseQuery);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain('unnest(sc."brokenKodyRulesIds")');
            expect(sql).toContain(`s."brokenKodyRulesIds" IS NOT NULL`);
            expect(sql).toContain('"analytics"."suggestion_feedback"');
            expect(rows).toEqual([
                {
                    ruleId: 'rule-1',
                    triggers: 87,
                    implemented: 16,
                    rate: 0.18,
                    thumbsUp: 2,
                    thumbsDown: 14,
                    lastTriggeredAt: '2026-05-22T10:00:00Z',
                },
            ]);
        });
    });

    describe('getReviewOperationalMetrics', () => {
        it('compares processed PRs, review volume and terminal status rates', async () => {
            query
                .mockResolvedValueOnce([
                    {
                        processed_prs: 10,
                        processed_reviews: 20,
                        successful_reviews: 14,
                        error_reviews: 4,
                        skipped_reviews: 2,
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        processed_prs: 5,
                        processed_reviews: 10,
                        successful_reviews: 8,
                        error_reviews: 1,
                        skipped_reviews: 1,
                    },
                ]);

            const res = await service.getReviewOperationalMetrics(baseQuery);

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain(
                '"analytics"."review_operational_executions" roe',
            );
            expect(sql).toContain('roe."organizationId" = $1');
            expect(sql).not.toContain('"automation_execution"');
            expect(sql).not.toContain('"code_review_execution"');
            expect(params).toEqual(['org-1', '2026-03-01', '2026-06-01']);

            expect(res.currentPeriod).toEqual({
                processedPRs: 10,
                processedReviews: 20,
                successfulReviews: 14,
                errorReviews: 4,
                skippedReviews: 2,
                successRate: 0.7,
                errorRate: 0.2,
                skippedRate: 0.1,
            });
            expect(res.previousPeriod.successRate).toBe(0.8);
            expect(res.comparison.processedPRs).toEqual({
                percentageChange: 100,
                trend: 'improved',
            });
            expect(res.comparison.successRate).toEqual({
                percentageChange: -12.5,
                percentagePointChange: -10,
                trend: 'worsened',
            });
            expect(res.comparison.errorRate).toEqual({
                percentageChange: 100,
                percentagePointChange: 10,
                trend: 'worsened',
            });
            expect(res.comparison.skippedRate).toEqual({
                percentageChange: 0,
                percentagePointChange: 0,
                trend: 'unchanged',
            });
        });

        it('applies the repository filter against repository full name', async () => {
            await service.getReviewOperationalMetrics({
                ...baseQuery,
                repository: 'org/repo',
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('roe."repo_full_name" = $4');
            expect(sql).not.toContain('FROM "repositories"');
            expect(params[3]).toBe('org/repo');
        });
    });

    describe('getReviewOperationalMetricsWeekly', () => {
        it('groups operational outcomes by week and derives rates', async () => {
            query.mockResolvedValue([
                {
                    week_start: '2026-05-04',
                    processed_prs: 4,
                    processed_reviews: 10,
                    successful_reviews: 6,
                    error_reviews: 1,
                    skipped_reviews: 3,
                },
                {
                    week_start: '2026-05-11',
                    processed_prs: 8,
                    processed_reviews: 20,
                    successful_reviews: 12,
                    error_reviews: 4,
                    skipped_reviews: 4,
                },
            ]);

            const rows =
                await service.getReviewOperationalMetricsWeekly(baseQuery);

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain(`date_trunc('week', roe."created_at")`);
            expect(sql).toContain(
                'GROUP BY week_start, "repositoryId", "pullRequestNumber"',
            );
            expect(sql).toContain('ORDER BY week_start ASC');
            // distinct-PR count is now a HashAggregate roll-up, not COUNT(DISTINCT)
            expect(sql).not.toContain('COUNT(DISTINCT');
            expect(sql).toContain(
                '"analytics"."review_operational_executions" roe',
            );
            expect(sql).not.toContain('"code_review_execution"');
            expect(params).toEqual(['org-1', '2026-03-01', '2026-06-01']);

            expect(rows).toEqual([
                {
                    weekStart: '2026-05-04',
                    processedPRs: 4,
                    processedReviews: 10,
                    successfulReviews: 6,
                    errorReviews: 1,
                    skippedReviews: 3,
                    successRate: 0.6,
                    errorRate: 0.1,
                    skippedRate: 0.3,
                },
                {
                    weekStart: '2026-05-11',
                    processedPRs: 8,
                    processedReviews: 20,
                    successfulReviews: 12,
                    errorReviews: 4,
                    skippedReviews: 4,
                    successRate: 0.6,
                    errorRate: 0.2,
                    skippedRate: 0.2,
                },
            ]);
        });

        it('applies the repository filter to weekly operational outcomes', async () => {
            await service.getReviewOperationalMetricsWeekly({
                ...baseQuery,
                repository: 'org/repo',
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('roe."repo_full_name" = $4');
            expect(sql).not.toContain('FROM "repositories"');
            expect(params[3]).toBe('org/repo');
        });
    });

    describe('negative feedback queries', () => {
        it('aggregates thumbs by category scoped to the feedback window', async () => {
            query.mockResolvedValue([
                { category: 'Code Style', thumbs_up: 1, thumbs_down: 19 },
            ]);

            const rows =
                await service.getNegativeFeedbackByCategory(baseQuery);

            const [sql, params] = query.mock.calls[0];
            // feedback is scoped to suggestions on closed PRs in the window
            // (joined), not by the reaction's own timestamp
            expect(sql).toContain('"analytics"."suggestion_feedback" f');
            expect(sql).toContain(
                `JOIN "analytics"."suggestions_mv" s ON s."suggestion_id" = f."suggestion_id"`,
            );
            expect(sql).toContain(`pr."status" = 'closed'`);
            expect(sql).toContain(`HAVING SUM(f."thumbs_up")`);
            expect(params).toEqual(['org-1', '2026-03-01', '2026-06-01']);
            expect(rows).toEqual([
                { category: 'Code Style', thumbsUp: 1, thumbsDown: 19 },
            ]);
        });

        it('reports no trend when the previous period had no feedback', async () => {
            query
                .mockResolvedValueOnce([{ thumbs_up: 3, thumbs_down: 5 }])
                .mockResolvedValueOnce([{ thumbs_up: 0, thumbs_down: 0 }]);

            const res = await service.getNegativeVoteRateHighlight(baseQuery);

            // no baseline → don't fabricate a +100% swing
            expect(res.comparison).toEqual({
                percentageChange: 0,
                trend: 'unchanged',
            });
        });

        it('computes the negative vote rate highlight vs the previous period', async () => {
            query
                .mockResolvedValueOnce([{ thumbs_up: 6, thumbs_down: 2 }])
                .mockResolvedValueOnce([{ thumbs_up: 2, thumbs_down: 2 }]);

            const res = await service.getNegativeVoteRateHighlight(baseQuery);

            expect(res.currentPeriod).toEqual({
                thumbsUp: 6,
                thumbsDown: 2,
                negativeRate: 0.25,
            });
            expect(res.previousPeriod.negativeRate).toBe(0.5);
            expect(res.comparison.trend).toBe('improved');
        });
    });

    describe('getRepositoriesHealth', () => {
        it('maps repo rows and the weakest category', async () => {
            query.mockResolvedValue([
                {
                    repository: 'org/repo',
                    prs_reviewed: 41,
                    thumbs_up: 9,
                    thumbs_down: 4,
                    sent: 142,
                    implemented: 72,
                    weakest_category: 'Code Style',
                    weakest_sent: 20,
                    weakest_implemented: 2,
                },
                {
                    repository: 'org/other',
                    prs_reviewed: 3,
                    thumbs_up: 0,
                    thumbs_down: 0,
                    sent: 4,
                    implemented: 2,
                    weakest_category: null,
                    weakest_sent: null,
                    weakest_implemented: null,
                },
            ]);

            const rows = await service.getRepositoriesHealth(baseQuery);

            expect(rows[0]).toEqual({
                repository: 'org/repo',
                prsReviewed: 41,
                suggestionsSent: 142,
                suggestionsImplemented: 72,
                implementationRate: 0.51,
                thumbsUp: 9,
                thumbsDown: 4,
                weakestCategory: { category: 'Code Style', sent: 20, rate: 0.1 },
            });
            expect(rows[1].weakestCategory).toBeNull();
        });
    });

    describe('searchSuggestions', () => {
        it('applies defaults and returns an empty page', async () => {
            const res = await service.searchSuggestions({
                organizationId: 'org-1',
                startDate: '2026-03-01',
                endDate: '2026-06-01',
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain(`s."suggestionCreatedAt" BETWEEN`);
            // LIMIT/OFFSET are the trailing params: pageSize 20, offset 0.
            expect(params.slice(-2)).toEqual([20, 0]);
            expect(res).toEqual({ total: 0, page: 1, pageSize: 20, items: [] });
        });

        it('binds every optional filter with correct placeholders', async () => {
            await service.searchSuggestions({
                organizationId: 'org-1',
                startDate: '2026-03-01',
                endDate: '2026-06-01',
                repository: 'org/repo',
                category: 'Security',
                severity: 'High',
                implementationStatus: 'implemented',
                search: 'sql_injection',
                page: 2,
                pageSize: 10,
            });

            const [sql, params] = query.mock.calls[0];
            expect(params).toEqual([
                'org-1',
                '2026-03-01',
                '2026-06-01',
                'org/repo',
                'Security',
                'high',
                'implemented',
                '%sql\\_injection%',
                10,
                10,
            ]);
            expect(sql).toContain('pr.repo_full_name = $4');
            expect(sql).toContain(`s."label" = $5`);
            expect(sql).toContain(`lower(s."severity") = $6`);
            expect(sql).toContain(`s."suggestionImplementationStatus" = $7`);
            expect(sql).toContain('ILIKE $8');
            expect(sql).toContain('LIMIT $9 OFFSET $10');
        });

        it('treats not_implemented as "not implemented or never evaluated"', async () => {
            await service.searchSuggestions({
                organizationId: 'org-1',
                startDate: '2026-03-01',
                endDate: '2026-06-01',
                implementationStatus: 'not_implemented',
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain(
                `s."suggestionImplementationStatus" IS NULL`,
            );
            expect(sql).toContain(
                `NOT IN ('implemented','partially_implemented')`,
            );
            // no extra bound param for the status filter
            expect(params).toEqual(['org-1', '2026-03-01', '2026-06-01', 20, 0]);
        });

        it('clamps pageSize and maps result rows', async () => {
            query.mockResolvedValue([
                {
                    suggestion_id: 'sg-1',
                    repository: 'org/repo',
                    file_path: 'src/a.ts',
                    category: 'Security',
                    severity: 'critical',
                    implementation_status: 'implemented',
                    summary: 'Use bind params',
                    existing_code: 'a',
                    improved_code: 'b',
                    language: 'typescript',
                    pull_request_id: 'pr-1',
                    pr_number: 1242,
                    comment_id: '123',
                    created_at: '2026-05-20T10:00:00Z',
                    total: 87,
                },
            ]);

            const res = await service.searchSuggestions({
                organizationId: 'org-1',
                startDate: '2026-03-01',
                endDate: '2026-06-01',
                pageSize: 9999,
            });

            const [, params] = query.mock.calls[0];
            expect(params.slice(-2)).toEqual([100, 0]);
            expect(res.total).toBe(87);
            expect(res.items[0]).toMatchObject({
                suggestionId: 'sg-1',
                prNumber: 1242,
                commentId: 123,
                severity: 'critical',
            });
        });
    });
});
