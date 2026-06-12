import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

import {
    computePreviousPeriod,
    computeTrend,
} from '../../application/date-range.util';
import { ICockpitReviewAnalyticsService } from '../../domain/contracts/cockpit-review-analytics.service.contract';
import {
    CockpitRangeQuery,
    IgnoredCriticalsHighlight,
    ImplementationRateByCategoryRow,
    KodyRuleUsageRow,
    NegativeFeedbackByCategoryRow,
    NegativeFeedbackWeeklyRow,
    NegativeVoteRateHighlight,
    ImplementationRateBySeverityRow,
    ImplementationRateWeeklyRow,
    RepositoryHealthRow,
    ReviewOperationalMetricComparison,
    ReviewOperationalMetrics,
    ReviewOperationalMetricsPeriod,
    ReviewOperationalMetricsWeeklyRow,
    ReviewOperationalRateComparison,
    SuggestionsExplorerItem,
    SuggestionsExplorerQuery,
    SuggestionsExplorerResult,
} from '../../domain/types';

/**
 * "Kodus Review" tab of the cockpit revamp — metrics about Kodus itself
 * (is the team acting on what we say?) rather than generic productivity.
 *
 * Conventions shared with `CockpitCodeHealthService`:
 *  - aggregations join `suggestions_mv` → `pull_requests_opt` and scope by
 *    the PR's `parsed_closed_at` window, since implementation status is only
 *    resolved once the PR closes;
 *  - only delivered suggestions count (`suggestionDeliveryStatus = 'sent'`);
 *  - "implemented" means `implemented` or `partially_implemented`;
 *  - rates are 0..1 ratios rounded to 2 decimals.
 *
 * The explorer is the exception: it scopes by `suggestionCreatedAt` so
 * suggestions on still-open PRs are also listed.
 */

const IMPLEMENTED = `IN ('implemented','partially_implemented')`;

/** Minimum sample for a category to qualify as a repo's "weakest". */
const WEAKEST_CATEGORY_MIN_SENT = 5;

const EXPLORER_DEFAULT_PAGE_SIZE = 20;
const EXPLORER_MAX_PAGE_SIZE = 100;
const IGNORED_CRITICALS_MAX_ITEMS = 50;

@Injectable()
export class CockpitReviewAnalyticsService
    implements ICockpitReviewAnalyticsService
{
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
    ) {}

    private round(value: number | string | null | undefined): number {
        return Number(Number(value ?? 0).toFixed(2));
    }

    private rate(sent: number, implemented: number): number {
        return sent === 0 ? 0 : this.round(implemented / sent);
    }

    /**
     * Shared WHERE for closed-PR-scoped aggregations (aliases `s` for the
     * suggestion and `pr` for the PR). Pushes params and returns the SQL
     * fragment with the right placeholders.
     */
    private closedPrWhere(q: CockpitRangeQuery, params: unknown[]): string {
        params.push(q.organizationId, q.startDate, q.endDate);
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';
        // `s."organizationId" = $1` is redundant with the join (s.org always
        // equals pr.org) but lets the planner restrict suggestions_mv via
        // `idx_sugg_mv_org` instead of seq-scanning the whole table — the
        // difference that matters for large multi-tenant orgs.
        return `pr."organizationId" = $1
                 AND s."organizationId" = $1
                 AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                 AND pr."status" = 'closed'
                 AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
                 AND s."suggestionDeliveryStatus" = 'sent'
                 ${repoFilter}`;
    }

    /** Shared FROM/WHERE built on top of {@link closedPrWhere}. */
    private closedPrScope(q: CockpitRangeQuery, params: unknown[]): string {
        return `FROM "analytics"."suggestions_mv" s
                JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
               WHERE ${this.closedPrWhere(q, params)}`;
    }

    async getImplementationRateWeekly(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateWeeklyRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                COALESCE(lower(s."severity"), 'unknown') AS severity,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
             ${scope}
             GROUP BY date_trunc('week', pr.parsed_closed_at), severity
             ORDER BY date_trunc('week', pr.parsed_closed_at) ASC`,
            params,
        )) as Array<{
            week_start: string;
            severity: string;
            sent: number;
            implemented: number;
        }>;

        const weeks = new Map<string, ImplementationRateWeeklyRow>();
        for (const r of rows) {
            let week = weeks.get(r.week_start);
            if (!week) {
                week = {
                    weekStart: r.week_start,
                    sent: 0,
                    implemented: 0,
                    rate: 0,
                    bySeverity: {},
                };
                weeks.set(r.week_start, week);
            }
            const sent = Number(r.sent);
            const implemented = Number(r.implemented);
            week.sent += sent;
            week.implemented += implemented;
            week.bySeverity[r.severity] = {
                sent,
                implemented,
                rate: this.rate(sent, implemented),
            };
        }

        return [...weeks.values()].map((w) => ({
            ...w,
            rate: this.rate(w.sent, w.implemented),
        }));
    }

    async getImplementationRateByCategory(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateByCategoryRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(s."label", 'Unknown') AS category,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
             ${scope}
             GROUP BY category
             ORDER BY sent DESC`,
            params,
        )) as Array<{ category: string; sent: number; implemented: number }>;

        return rows.map((r) => ({
            category: r.category,
            sent: Number(r.sent),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.sent), Number(r.implemented)),
        }));
    }

    async getImplementationRateBySeverity(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateBySeverityRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        // A suggestion is rule-driven when it enforces a Kody Rule (or is
        // labelled as such). Its severity is user-defined on the rule, not a
        // Kodus risk call — so the chart exposes both the full population and
        // a Kodus-native one (toggled client-side) to keep the calibration
        // read honest.
        const IS_KODY_RULE = `(s."brokenKodyRulesIds" IS NOT NULL OR lower(s."label") = 'kody_rules')`;

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(lower(s."severity"), 'unknown') AS severity,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented,
                COUNT(*) FILTER (WHERE NOT ${IS_KODY_RULE})::int AS native_sent,
                COUNT(*) FILTER (WHERE NOT ${IS_KODY_RULE} AND s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS native_implemented
             ${scope}
             GROUP BY severity
             ORDER BY CASE COALESCE(lower(s."severity"), 'unknown')
                          WHEN 'critical' THEN 0
                          WHEN 'high' THEN 1
                          WHEN 'medium' THEN 2
                          WHEN 'low' THEN 3
                          ELSE 4
                      END`,
            params,
        )) as Array<{
            severity: string;
            sent: number;
            implemented: number;
            native_sent: number;
            native_implemented: number;
        }>;

        return rows.map((r) => ({
            severity: r.severity,
            sent: Number(r.sent),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.sent), Number(r.implemented)),
            nativeSent: Number(r.native_sent),
            nativeImplemented: Number(r.native_implemented),
            nativeRate: this.rate(
                Number(r.native_sent),
                Number(r.native_implemented),
            ),
        }));
    }

    async getIgnoredCriticals(
        q: CockpitRangeQuery,
    ): Promise<IgnoredCriticalsHighlight> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                s."suggestion_id" AS suggestion_id,
                pr.repo_full_name AS repository,
                s."filePath" AS file_path,
                s."label" AS category,
                s."raw"->>'oneSentenceSummary' AS summary,
                s."pullRequestId" AS pull_request_id,
                pr."pr_number" AS pr_number,
                to_char(pr.parsed_closed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pr_closed_at,
                COUNT(*) OVER ()::int AS total
             ${scope}
                 AND lower(s."severity") = 'critical'
                 AND (s."suggestionImplementationStatus" IS NULL
                      OR s."suggestionImplementationStatus" NOT ${IMPLEMENTED})
             ORDER BY pr.parsed_closed_at DESC
             LIMIT ${IGNORED_CRITICALS_MAX_ITEMS}`,
            params,
        )) as Array<{
            suggestion_id: string;
            repository: string | null;
            file_path: string | null;
            category: string | null;
            summary: string | null;
            pull_request_id: string;
            pr_number: number | null;
            pr_closed_at: string | null;
            total: number;
        }>;

        return {
            count: rows.length ? Number(rows[0].total) : 0,
            items: rows.map((r) => ({
                suggestionId: r.suggestion_id,
                repository: r.repository,
                filePath: r.file_path,
                category: r.category,
                summary: r.summary,
                pullRequestId: r.pull_request_id,
                prNumber: r.pr_number === null ? null : Number(r.pr_number),
                prClosedAt: r.pr_closed_at,
            })),
        };
    }

    async getRepositoriesHealth(
        q: CockpitRangeQuery,
    ): Promise<RepositoryHealthRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `WITH per_category AS (
                SELECT
                    COALESCE(pr.repo_full_name, 'Unknown') AS repository,
                    COALESCE(s."label", 'Unknown') AS category,
                    COUNT(*)::int AS sent,
                    COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
                ${scope}
                GROUP BY repository, category
            ),
            per_repo AS (
                SELECT repository,
                       SUM(sent)::int AS sent,
                       SUM(implemented)::int AS implemented
                  FROM per_category
                 GROUP BY repository
            ),
            -- distinct PRs cannot be derived from per_category; recount.
            repo_prs AS (
                SELECT COALESCE(pr.repo_full_name, 'Unknown') AS repository,
                       COUNT(DISTINCT s."pullRequestId")::int AS prs_reviewed,
                       COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                       COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down
                  FROM "analytics"."suggestions_mv" s
                  JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
                  LEFT JOIN "analytics"."suggestion_feedback" f
                         ON f."suggestion_id" = s."suggestion_id"
                 WHERE ${this.closedPrWhere(q, [])
                     /* placeholders $1..$N are shared with the other CTEs;
                        re-render with a throwaway array to avoid double-push */
                     .trim()}
                GROUP BY repository
            ),
            weakest AS (
                SELECT DISTINCT ON (repository)
                       repository, category, sent, implemented
                  FROM per_category
                 WHERE sent >= ${WEAKEST_CATEGORY_MIN_SENT}
                 ORDER BY repository,
                          (implemented::numeric / NULLIF(sent, 0)) ASC,
                          sent DESC
            )
            SELECT pr_agg.repository,
                   rp.prs_reviewed,
                   rp.thumbs_up,
                   rp.thumbs_down,
                   pr_agg.sent,
                   pr_agg.implemented,
                   w.category AS weakest_category,
                   w.sent AS weakest_sent,
                   w.implemented AS weakest_implemented
              FROM per_repo pr_agg
              JOIN repo_prs rp ON rp.repository = pr_agg.repository
              LEFT JOIN weakest w ON w.repository = pr_agg.repository
             ORDER BY pr_agg.sent DESC`,
            params,
        )) as Array<{
            repository: string;
            prs_reviewed: number;
            thumbs_up: number;
            thumbs_down: number;
            sent: number;
            implemented: number;
            weakest_category: string | null;
            weakest_sent: number | null;
            weakest_implemented: number | null;
        }>;

        return rows.map((r) => ({
            repository: r.repository,
            prsReviewed: Number(r.prs_reviewed),
            suggestionsSent: Number(r.sent),
            suggestionsImplemented: Number(r.implemented),
            implementationRate: this.rate(
                Number(r.sent),
                Number(r.implemented),
            ),
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
            weakestCategory: r.weakest_category
                ? {
                      category: r.weakest_category,
                      sent: Number(r.weakest_sent),
                      rate: this.rate(
                          Number(r.weakest_sent),
                          Number(r.weakest_implemented ?? 0),
                      ),
                  }
                : null,
        }));
    }

    /**
     * Shared FROM/WHERE for feedback aggregations. Scopes reactions to the
     * SAME universe as every other chart — suggestions Kodus delivered on
     * PRs closed in the window — by joining feedback → suggestion → PR.
     *
     * This is deliberate: scoping by the reaction's own timestamp instead
     * let in 👎/👍 on suggestions that aren't in the warehouse (older than
     * the window, un-ingested PRs), which surfaced as a bogus "Unknown"
     * category and made the card total disagree with the breakdown.
     */
    private feedbackScope(q: CockpitRangeQuery, params: unknown[]): string {
        return `FROM "analytics"."suggestion_feedback" f
                JOIN "analytics"."suggestions_mv" s ON s."suggestion_id" = f."suggestion_id"
                JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
               WHERE ${this.closedPrWhere(q, params)}`;
    }

    async getNegativeFeedbackByCategory(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackByCategoryRow[]> {
        const params: unknown[] = [];
        const scope = this.feedbackScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(s."label", 'Uncategorized') AS category,
                SUM(f."thumbs_up")::int AS thumbs_up,
                SUM(f."thumbs_down")::int AS thumbs_down
             ${scope}
             GROUP BY category
             HAVING SUM(f."thumbs_up") + SUM(f."thumbs_down") > 0
             ORDER BY thumbs_down DESC`,
            params,
        )) as Array<{
            category: string;
            thumbs_up: number;
            thumbs_down: number;
        }>;

        return rows.map((r) => ({
            category: r.category,
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
        }));
    }

    async getNegativeFeedbackWeekly(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackWeeklyRow[]> {
        const params: unknown[] = [];
        const scope = this.feedbackScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                SUM(f."thumbs_up")::int AS thumbs_up,
                SUM(f."thumbs_down")::int AS thumbs_down
             ${scope}
             GROUP BY date_trunc('week', pr.parsed_closed_at)
             ORDER BY date_trunc('week', pr.parsed_closed_at) ASC`,
            params,
        )) as Array<{
            week_start: string;
            thumbs_up: number;
            thumbs_down: number;
        }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
        }));
    }

    async getNegativeVoteRateHighlight(
        q: CockpitRangeQuery,
    ): Promise<NegativeVoteRateHighlight> {
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (startDate: string, endDate: string) => {
            const params: unknown[] = [];
            const scope = this.feedbackScope(
                { ...q, startDate, endDate },
                params,
            );
            const rows = (await this.ds.query(
                `SELECT
                    COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                    COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down
                 ${scope}`,
                params,
            )) as Array<{ thumbs_up: number; thumbs_down: number }>;
            const r = rows[0] ?? { thumbs_up: 0, thumbs_down: 0 };
            const up = Number(r.thumbs_up);
            const down = Number(r.thumbs_down);
            return {
                thumbsUp: up,
                thumbsDown: down,
                negativeRate: this.rate(up + down, down),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        // No feedback last period → there's no baseline to compare against,
        // so don't fabricate a "+100%" trend.
        const hadPreviousBaseline =
            previous.thumbsUp + previous.thumbsDown > 0;
        const comparison = hadPreviousBaseline
            ? computeTrend(current.negativeRate, previous.negativeRate, 'down')
            : { percentageChange: 0, trend: 'unchanged' as const };

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison,
        };
    }

    async getReviewOperationalMetrics(
        q: CockpitRangeQuery,
    ): Promise<ReviewOperationalMetrics> {
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const [current, previous] = await Promise.all([
            this.getReviewOperationalMetricsPeriod(q),
            this.getReviewOperationalMetricsPeriod({
                ...q,
                startDate: prev.startDate,
                endDate: prev.endDate,
            }),
        ]);

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison: {
                processedPRs: this.compareOperationalMetric(
                    current.processedPRs,
                    previous.processedPRs,
                    'up',
                ),
                processedReviews: this.compareOperationalMetric(
                    current.processedReviews,
                    previous.processedReviews,
                    'up',
                ),
                successRate: this.compareOperationalRate(
                    current.successRate,
                    previous.successRate,
                    'up',
                ),
                errorRate: this.compareOperationalRate(
                    current.errorRate,
                    previous.errorRate,
                    'down',
                ),
                skippedRate: this.compareOperationalRate(
                    current.skippedRate,
                    previous.skippedRate,
                    'down',
                ),
            },
        };
    }

    async getReviewOperationalMetricsWeekly(
        q: CockpitRangeQuery,
    ): Promise<ReviewOperationalMetricsWeeklyRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repositoryFilter = q.repository
            ? (params.push(q.repository),
              `AND roe."repo_full_name" = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            // Same HashAggregate-over-PR-key rewrite as the period query: group
            // by (week, repo, PR) once, then roll the per-PR tallies up per
            // week. Avoids the disk-spilling COUNT(DISTINCT) sort; identical
            // results.
            `WITH scoped AS (
                SELECT
                    date_trunc('week', roe."created_at") AS week_start,
                    roe."status",
                    roe."repositoryId",
                    roe."pullRequestNumber"
                  FROM "analytics"."review_operational_executions" roe
                 WHERE roe."organizationId" = $1
                   AND roe."created_at" >= $2::date
                   AND roe."created_at" < ($3::date + INTERVAL '1 day')
                   ${repositoryFilter}
            ),
            per_pr AS (
                SELECT
                    week_start,
                    COUNT(*) AS reviews,
                    COUNT(*) FILTER (WHERE "status" = 'success') AS successful,
                    COUNT(*) FILTER (WHERE "status" IN ('error', 'partial_error')) AS errored,
                    COUNT(*) FILTER (WHERE "status" = 'skipped') AS skipped
                  FROM scoped
                 GROUP BY week_start, "repositoryId", "pullRequestNumber"
            )
            SELECT
                to_char(week_start, 'YYYY-MM-DD') AS week_start,
                COALESCE(SUM(reviews), 0)::int AS processed_reviews,
                COUNT(*)::int AS processed_prs,
                COALESCE(SUM(successful), 0)::int AS successful_reviews,
                COALESCE(SUM(errored), 0)::int AS error_reviews,
                COALESCE(SUM(skipped), 0)::int AS skipped_reviews
              FROM per_pr
             GROUP BY week_start
             ORDER BY week_start ASC`,
            params,
        )) as Array<{
            week_start: string;
            processed_reviews: number | string | null;
            processed_prs: number | string | null;
            successful_reviews: number | string | null;
            error_reviews: number | string | null;
            skipped_reviews: number | string | null;
        }>;

        return rows.map((row) => {
            const processedReviews = Number(row.processed_reviews ?? 0);
            const successfulReviews = Number(row.successful_reviews ?? 0);
            const errorReviews = Number(row.error_reviews ?? 0);
            const skippedReviews = Number(row.skipped_reviews ?? 0);

            return {
                weekStart: row.week_start,
                processedPRs: Number(row.processed_prs ?? 0),
                processedReviews,
                successfulReviews,
                errorReviews,
                skippedReviews,
                successRate: this.rate(processedReviews, successfulReviews),
                errorRate: this.rate(processedReviews, errorReviews),
                skippedRate: this.rate(processedReviews, skippedReviews),
            };
        });
    }

    private async getReviewOperationalMetricsPeriod(
        q: CockpitRangeQuery,
    ): Promise<ReviewOperationalMetricsPeriod> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repositoryFilter = q.repository
            ? (params.push(q.repository),
              `AND roe."repo_full_name" = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            // processed_prs is a distinct (repo, PR) count. Grouping by the
            // PR key once (HashAggregate) and summing the per-PR tallies is
            // ~4-8x faster than COUNT(DISTINCT ...), which forces a full sort
            // that spills to disk on high-volume orgs. Results are identical.
            `WITH scoped AS (
                SELECT
                    roe."status",
                    roe."repositoryId",
                    roe."pullRequestNumber"
                  FROM "analytics"."review_operational_executions" roe
                 WHERE roe."organizationId" = $1
                   AND roe."created_at" >= $2::date
                   AND roe."created_at" < ($3::date + INTERVAL '1 day')
                   ${repositoryFilter}
            ),
            per_pr AS (
                SELECT
                    COUNT(*) AS reviews,
                    COUNT(*) FILTER (WHERE "status" = 'success') AS successful,
                    COUNT(*) FILTER (WHERE "status" IN ('error', 'partial_error')) AS errored,
                    COUNT(*) FILTER (WHERE "status" = 'skipped') AS skipped
                  FROM scoped
                 GROUP BY "repositoryId", "pullRequestNumber"
            )
            SELECT
                COALESCE(SUM(reviews), 0)::int AS processed_reviews,
                COUNT(*)::int AS processed_prs,
                COALESCE(SUM(successful), 0)::int AS successful_reviews,
                COALESCE(SUM(errored), 0)::int AS error_reviews,
                COALESCE(SUM(skipped), 0)::int AS skipped_reviews
              FROM per_pr`,
            params,
        )) as Array<{
            processed_reviews: number | string | null;
            processed_prs: number | string | null;
            successful_reviews: number | string | null;
            error_reviews: number | string | null;
            skipped_reviews: number | string | null;
        }>;

        const row = rows[0] ?? {
            processed_reviews: 0,
            processed_prs: 0,
            successful_reviews: 0,
            error_reviews: 0,
            skipped_reviews: 0,
        };
        const processedReviews = Number(row.processed_reviews ?? 0);
        const successfulReviews = Number(row.successful_reviews ?? 0);
        const errorReviews = Number(row.error_reviews ?? 0);
        const skippedReviews = Number(row.skipped_reviews ?? 0);

        return {
            processedPRs: Number(row.processed_prs ?? 0),
            processedReviews,
            successfulReviews,
            errorReviews,
            skippedReviews,
            successRate: this.rate(processedReviews, successfulReviews),
            errorRate: this.rate(processedReviews, errorReviews),
            skippedRate: this.rate(processedReviews, skippedReviews),
        };
    }

    private compareOperationalMetric(
        current: number,
        previous: number,
        direction: 'up' | 'down',
    ): ReviewOperationalMetricComparison {
        return computeTrend(current, previous, direction);
    }

    private compareOperationalRate(
        current: number,
        previous: number,
        direction: 'up' | 'down',
    ): ReviewOperationalRateComparison {
        return {
            ...computeTrend(current, previous, direction),
            percentagePointChange: this.round((current - previous) * 100),
        };
    }

    /**
     * Per-rule usage from `suggestions_mv.brokenKodyRulesIds` (one
     * suggestion may enforce several rules — it counts once per rule).
     * Rule metadata (title, status, zero-trigger rules) lives in Mongo;
     * `GetKodyRulesHealthUseCase` does the merge.
     */
    async getKodyRulesUsage(
        q: CockpitRangeQuery,
    ): Promise<KodyRuleUsageRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `WITH scoped AS (
                SELECT s."suggestion_id",
                       s."suggestionImplementationStatus",
                       s."suggestionCreatedAt",
                       s."brokenKodyRulesIds"
                ${scope}
                    AND s."brokenKodyRulesIds" IS NOT NULL
            )
            SELECT
                rule_id,
                COUNT(*)::int AS triggers,
                COUNT(*) FILTER (WHERE sc."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented,
                COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down,
                to_char(MAX(sc."suggestionCreatedAt"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_triggered_at
              FROM scoped sc
              LEFT JOIN "analytics"."suggestion_feedback" f
                     ON f."suggestion_id" = sc."suggestion_id"
             CROSS JOIN LATERAL unnest(sc."brokenKodyRulesIds") AS rule_id
             GROUP BY rule_id
             ORDER BY triggers DESC`,
            params,
        )) as Array<{
            rule_id: string;
            triggers: number;
            implemented: number;
            thumbs_up: number;
            thumbs_down: number;
            last_triggered_at: string | null;
        }>;

        return rows.map((r) => ({
            ruleId: r.rule_id,
            triggers: Number(r.triggers),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.triggers), Number(r.implemented)),
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
            lastTriggeredAt: r.last_triggered_at,
        }));
    }

    async getRepositoryNames(
        organizationId: string,
    ): Promise<Map<string, string>> {
        const rows = (await this.ds.query(
            `SELECT DISTINCT pr."repositoryId" AS id, pr."repo_full_name" AS name
               FROM "analytics"."pull_requests_opt" pr
              WHERE pr."organizationId" = $1
                AND pr."repositoryId" IS NOT NULL
                AND pr."repo_full_name" IS NOT NULL`,
            [organizationId],
        )) as Array<{ id: string; name: string }>;

        return new Map(rows.map((r) => [r.id, r.name]));
    }

    async searchSuggestions(
        q: SuggestionsExplorerQuery,
    ): Promise<SuggestionsExplorerResult> {
        const page = Math.max(1, Math.floor(q.page ?? 1));
        const pageSize = Math.min(
            EXPLORER_MAX_PAGE_SIZE,
            Math.max(1, Math.floor(q.pageSize ?? EXPLORER_DEFAULT_PAGE_SIZE)),
        );

        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const filters: string[] = [];

        if (q.repository) {
            params.push(q.repository);
            filters.push(`AND pr.repo_full_name = $${params.length}`);
        }
        if (q.category) {
            params.push(q.category);
            filters.push(`AND s."label" = $${params.length}`);
        }
        if (q.severity) {
            params.push(q.severity.toLowerCase());
            filters.push(`AND lower(s."severity") = $${params.length}`);
        }
        if (q.ruleId) {
            params.push(q.ruleId);
            filters.push(
                `AND s."brokenKodyRulesIds" @> ARRAY[$${params.length}]::text[]`,
            );
        }
        if (q.implementationStatus) {
            if (q.implementationStatus === 'not_implemented') {
                // Suggestions never evaluated land here too — for the user
                // both read as "the team did not act on this".
                filters.push(
                    `AND (s."suggestionImplementationStatus" IS NULL
                          OR s."suggestionImplementationStatus" NOT ${IMPLEMENTED})`,
                );
            } else {
                params.push(q.implementationStatus);
                filters.push(
                    `AND s."suggestionImplementationStatus" = $${params.length}`,
                );
            }
        }
        if (q.search) {
            params.push(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
            filters.push(
                `AND (s."raw"->>'oneSentenceSummary' ILIKE $${params.length}
                      OR s."filePath" ILIKE $${params.length})`,
            );
        }

        params.push(pageSize, (page - 1) * pageSize);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const rows = (await this.ds.query(
            `SELECT
                s."suggestion_id" AS suggestion_id,
                pr.repo_full_name AS repository,
                s."filePath" AS file_path,
                s."label" AS category,
                lower(s."severity") AS severity,
                s."suggestionImplementationStatus" AS implementation_status,
                s."raw"->>'oneSentenceSummary' AS summary,
                s."raw"->>'existingCode' AS existing_code,
                s."raw"->>'improvedCode' AS improved_code,
                s."raw"->>'language' AS language,
                s."pullRequestId" AS pull_request_id,
                s."repositoryId" AS repository_id,
                pr."pr_number" AS pr_number,
                (s."raw"->'comment'->>'id')::bigint AS comment_id,
                to_char(s."suggestionCreatedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                COUNT(*) OVER ()::int AS total
             FROM "analytics"."suggestions_mv" s
             JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
             WHERE pr."organizationId" = $1
               AND s."suggestionDeliveryStatus" = 'sent'
               AND s."suggestionCreatedAt" BETWEEN $2::timestamptz AND $3::timestamptz
               ${filters.join('\n               ')}
             ORDER BY s."suggestionCreatedAt" DESC NULLS LAST, s."suggestion_id"
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            params,
        )) as Array<{
            suggestion_id: string;
            repository: string | null;
            file_path: string | null;
            category: string | null;
            severity: string | null;
            implementation_status: string | null;
            summary: string | null;
            existing_code: string | null;
            improved_code: string | null;
            language: string | null;
            pull_request_id: string;
            repository_id: string | null;
            pr_number: number | null;
            comment_id: string | number | null;
            created_at: string | null;
            total: number;
        }>;

        const items: SuggestionsExplorerItem[] = rows.map((r) => ({
            suggestionId: r.suggestion_id,
            repository: r.repository,
            repositoryId: r.repository_id,
            filePath: r.file_path,
            category: r.category,
            severity: r.severity,
            implementationStatus: r.implementation_status,
            summary: r.summary,
            existingCode: r.existing_code,
            improvedCode: r.improved_code,
            language: r.language,
            pullRequestId: r.pull_request_id,
            prNumber: r.pr_number === null ? null : Number(r.pr_number),
            commentId: r.comment_id === null ? null : Number(r.comment_id),
            createdAt: r.created_at,
        }));

        return {
            total: rows.length ? Number(rows[0].total) : 0,
            page,
            pageSize,
            items,
        };
    }
}
