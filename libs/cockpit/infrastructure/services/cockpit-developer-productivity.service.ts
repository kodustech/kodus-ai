import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

import {
    assertIsoDate,
    computePreviousPeriod,
    computeTrend,
} from '../../application/date-range.util';
import {
    CockpitRangeQuery,
    CompanyDashboard,
    DeployFrequencyHighlight,
    DeployFrequencyRow,
    DeveloperActivityRow,
    LeadTimeBreakdownRow,
    LeadTimeHighlight,
    LeadTimeRow,
    PRSizeHighlight,
    PullRequestSizeRow,
    PullRequestsByDevRow,
    PullRequestsOpenedVsClosedRow,
    SuggestionCategoryCount,
} from '../../domain/types';
import { ICockpitDeveloperProductivityService } from '../../domain/contracts/cockpit-developer-productivity.service.contract';
import { CockpitCodeHealthService } from './cockpit-code-health.service';

/**
 * Postgres port of
 * `kodus-service-analytics/src/services/analytics/developer-productivity.service.ts`.
 * `pull_request_author_view` from BQ collapses into
 * `pull_requests_opt.author_username` here — we already populate it on
 * ingestion, so no extra view is needed.
 */
@Injectable()
export class CockpitDeveloperProductivityService
    implements ICockpitDeveloperProductivityService
{
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
        private readonly codeHealth: CockpitCodeHealthService,
    ) {}

    async getDeployFrequencyChart(
        q: CockpitRangeQuery,
    ): Promise<DeployFrequencyRow[]> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');

        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                    COUNT(*)::int AS pr_count
               FROM "analytics"."pull_requests_opt" pr
              WHERE pr."closedAt" IS NOT NULL
                AND pr."status" = 'closed'
                AND pr.parsed_closed_at >= $2::timestamptz
                AND pr.parsed_closed_at <= $3::timestamptz
                AND pr."organizationId" = $1
                ${repoFilter}
              GROUP BY date_trunc('week', pr.parsed_closed_at)
              ORDER BY date_trunc('week', pr.parsed_closed_at)`,
            params,
        )) as Array<{ week_start: string; pr_count: number }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            prCount: Number(r.pr_count),
        }));
    }

    async getDeployFrequencyHighlight(
        q: CockpitRangeQuery,
    ): Promise<DeployFrequencyHighlight> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (start: string, end: string) => {
            const params: unknown[] = [q.organizationId, start, end];
            const repoFilter = q.repository
                ? (params.push(q.repository),
                  `AND pr.repo_full_name = $${params.length}`)
                : '';
            const rows = (await this.ds.query(
                `SELECT COUNT(*)::int AS total_deployments,
                        (COUNT(*)::numeric / GREATEST(CEIL(GREATEST(($3::date - $2::date), 1)::numeric / 7), 1)) AS avg_per_week
                   FROM "analytics"."pull_requests_opt" pr
                  WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr."status" = 'closed'
                    AND pr.parsed_closed_at >= $2::timestamptz
                    AND pr.parsed_closed_at <= $3::timestamptz
                    AND pr."organizationId" = $1
                    ${repoFilter}`,
                params,
            )) as Array<{
                total_deployments: number;
                avg_per_week: number | string | null;
            }>;
            const r = rows[0] ?? { total_deployments: 0, avg_per_week: 0 };
            return {
                totalDeployments: Number(r.total_deployments),
                averagePerWeek: Number(Number(r.avg_per_week ?? 0).toFixed(2)),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        const { percentageChange, trend } = computeTrend(
            current.averagePerWeek,
            previous.averagePerWeek,
            'up',
        );

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison: { percentageChange, trend },
        };
    }

    async getLeadTimeChart(q: CockpitRangeQuery): Promise<LeadTimeRow[]> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');

        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        // "PR Cycle Time" = duration the PR was open (opened → closed).
        // Departs from the legacy BQ semantic of `closed - MIN(commit)`
        // because that definition produces absurd p75 values (days or
        // weeks) when branches carry rebased/ancestral commits whose
        // `author.date` is far in the past — a common pattern. Using
        // opened_at keeps the metric stable and defensible.
        const rows = (await this.ds.query(
            `WITH pr_lead_times AS (
                SELECT date_trunc('week', pr.parsed_closed_at) AS week_start,
                       EXTRACT(EPOCH FROM (pr.parsed_closed_at - pr.parsed_opened_at)) / 60 AS lead_time_minutes
                  FROM "analytics"."pull_requests_opt" pr
                 WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                   AND pr."status" = 'closed'
                   AND pr.parsed_closed_at >= $2::timestamptz
                   AND pr.parsed_closed_at <= $3::timestamptz
                   AND pr.parsed_opened_at IS NOT NULL
                   AND pr."organizationId" = $1
                   ${repoFilter}
            )
            SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start,
                   percentile_cont(0.75) WITHIN GROUP (ORDER BY lead_time_minutes) AS lead_time_p75_minutes
              FROM pr_lead_times
             GROUP BY week_start
             ORDER BY week_start`,
            params,
        )) as Array<{
            week_start: string;
            lead_time_p75_minutes: number | string | null;
        }>;

        return rows.map((r) => {
            const minutes = Number(Number(r.lead_time_p75_minutes ?? 0).toFixed(2));
            return {
                weekStart: r.week_start,
                leadTimeP75Minutes: minutes,
                leadTimeP75Hours: Number((minutes / 60).toFixed(2)),
            };
        });
    }

    async getLeadTimeHighlight(
        q: CockpitRangeQuery,
    ): Promise<LeadTimeHighlight> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (start: string, end: string) => {
            const params: unknown[] = [q.organizationId, start, end];
            const repoFilter = q.repository
                ? (params.push(q.repository),
                  `AND pr.repo_full_name = $${params.length}`)
                : '';
            // See `getLeadTimeChart` for the rationale on opened→closed
            // over the legacy `closed - MIN(commit)` semantic.
            const rows = (await this.ds.query(
                `WITH pr_lead_times AS (
                    SELECT EXTRACT(EPOCH FROM (pr.parsed_closed_at - pr.parsed_opened_at)) / 60 AS lead_time_minutes
                      FROM "analytics"."pull_requests_opt" pr
                     WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                       AND pr."status" = 'closed'
                       AND pr.parsed_closed_at BETWEEN $2::timestamptz AND $3::timestamptz
                       AND pr.parsed_opened_at IS NOT NULL
                       AND pr."organizationId" = $1
                       ${repoFilter}
                )
                SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY lead_time_minutes) AS p75
                  FROM pr_lead_times`,
                params,
            )) as Array<{ p75: number | string | null }>;
            const minutes = Number(Number(rows[0]?.p75 ?? 0).toFixed(2));
            return {
                leadTimeP75Minutes: minutes,
                leadTimeP75Hours: Number((minutes / 60).toFixed(2)),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        const { percentageChange, trend } = computeTrend(
            current.leadTimeP75Minutes,
            previous.leadTimeP75Minutes,
            'down',
        );

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison: { percentageChange, trend },
        };
    }

    async getPullRequestsByDev(
        q: CockpitRangeQuery,
    ): Promise<PullRequestsByDevRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                    pr.author_username AS author,
                    COUNT(*)::int AS pr_count
               FROM "analytics"."pull_requests_opt" pr
              WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                AND pr."status" = 'closed'
                AND pr.parsed_closed_at >= $2::timestamptz
                AND pr.parsed_closed_at <= $3::timestamptz
                AND pr."organizationId" = $1
                AND pr.author_username IS NOT NULL
                AND btrim(pr.author_username) <> ''
                ${repoFilter}
              GROUP BY date_trunc('week', pr.parsed_closed_at), pr.author_username
              ORDER BY date_trunc('week', pr.parsed_closed_at), pr.author_username`,
            params,
        )) as Array<{ week_start: string; author: string; pr_count: number }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            author: r.author,
            prCount: Number(r.pr_count),
        }));
    }

    async getPullRequestSizeHighlight(
        q: CockpitRangeQuery,
    ): Promise<PRSizeHighlight> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (start: string, end: string) => {
            const params: unknown[] = [q.organizationId, start, end];
            const repoFilter = q.repository
                ? (params.push(q.repository),
                  `AND pr.repo_full_name = $${params.length}`)
                : '';
            const rows = (await this.ds.query(
                `SELECT COUNT(*)::int AS total_prs,
                        ROUND(AVG(COALESCE(pr."totalChanges", 0))::numeric, 2) AS avg_pr_size
                   FROM "analytics"."pull_requests_opt" pr
                  WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr."status" = 'closed'
                    AND pr.parsed_closed_at BETWEEN $2::timestamptz AND $3::timestamptz
                    AND pr."organizationId" = $1
                    ${repoFilter}`,
                params,
            )) as Array<{
                total_prs: number;
                avg_pr_size: number | string | null;
            }>;
            const r = rows[0] ?? { total_prs: 0, avg_pr_size: 0 };
            return {
                totalPRs: Number(r.total_prs),
                averagePRSize: Number(Number(r.avg_pr_size ?? 0)),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        const { percentageChange, trend } = computeTrend(
            current.averagePRSize,
            previous.averagePRSize,
            'down',
        );

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison: { percentageChange, trend },
        };
    }

    async getPullRequestSizeChart(
        q: CockpitRangeQuery,
    ): Promise<PullRequestSizeRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                    ROUND(AVG(COALESCE(pr."totalChanges", 0))::numeric, 2) AS avg_pr_size,
                    COUNT(*)::int AS total_prs
               FROM "analytics"."pull_requests_opt" pr
              WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                AND pr."status" = 'closed'
                AND pr.parsed_closed_at BETWEEN $2::timestamptz AND $3::timestamptz
                AND pr."organizationId" = $1
                ${repoFilter}
              GROUP BY date_trunc('week', pr.parsed_closed_at)
              ORDER BY date_trunc('week', pr.parsed_closed_at)`,
            params,
        )) as Array<{
            week_start: string;
            avg_pr_size: number | string | null;
            total_prs: number;
        }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            averagePRSize: Number(r.avg_pr_size ?? 0),
            totalPRs: Number(r.total_prs),
        }));
    }

    async getLeadTimeBreakdown(
        q: CockpitRangeQuery,
    ): Promise<LeadTimeBreakdownRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        // Webhook payloads only carry `author.date`, not `committer.date`.
        // For rebased branches that means the "first commit" can be the
        // author-date of a main-branch ancestor from weeks or months
        // before the PR existed, inflating `coding_time` to absurd
        // values. Cap the commit JOIN to a 30-day window before
        // `parsed_opened_at` — beyond that the commit is almost
        // certainly a rebased ancestor. Feature branches older than
        // 30 days drop out (better than reporting garbage).
        const rows = (await this.ds.query(
            `WITH pr_lead_times AS (
                SELECT pr."_id",
                       pr.parsed_opened_at AS opened_at,
                       pr.parsed_closed_at AS closed_at,
                       date_trunc('week', pr.parsed_closed_at) AS week_start,
                       MIN(c.commit_timestamp) AS first_commit,
                       MAX(c.commit_timestamp) AS last_commit
                  FROM "analytics"."pull_requests_opt" pr
                  JOIN "analytics"."commits_view" c
                    ON pr."_id" = c.pull_request_id
                   AND c.commit_timestamp >= pr.parsed_opened_at - interval '30 days'
                 WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                   AND pr."status" = 'closed'
                   AND pr.parsed_closed_at BETWEEN $2::timestamptz AND $3::timestamptz
                   AND pr."organizationId" = $1
                   ${repoFilter}
                 GROUP BY pr."_id", pr.parsed_opened_at, pr.parsed_closed_at
            )
            SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start,
                   COUNT(*)::int AS pr_count,
                   ROUND((percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (last_commit - first_commit)), 0)) / 60)::numeric, 2) AS coding_time_minutes,
                   ROUND((percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (opened_at - last_commit)), 0)) / 60)::numeric, 2) AS pickup_time_minutes,
                   ROUND((percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (closed_at - opened_at)), 0)) / 60)::numeric, 2) AS review_time_minutes,
                   ROUND(((
                       COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (last_commit - first_commit)), 0)), 0) +
                       COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (opened_at - last_commit)), 0)), 0) +
                       COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY NULLIF(EXTRACT(EPOCH FROM (closed_at - opened_at)), 0)), 0)
                   ) / 60)::numeric, 2) AS total_time_minutes
              FROM pr_lead_times
             WHERE first_commit IS NOT NULL
               AND last_commit IS NOT NULL
               AND opened_at IS NOT NULL
               AND closed_at IS NOT NULL
               AND first_commit <= last_commit
               AND opened_at <= closed_at
             GROUP BY week_start
             ORDER BY week_start`,
            params,
        )) as Array<{
            week_start: string;
            pr_count: number;
            coding_time_minutes: number | string | null;
            pickup_time_minutes: number | string | null;
            review_time_minutes: number | string | null;
            total_time_minutes: number | string | null;
        }>;

        return rows.map((r) => {
            const coding = Number(r.coding_time_minutes ?? 0);
            const pickup = Number(r.pickup_time_minutes ?? 0);
            const review = Number(r.review_time_minutes ?? 0);
            const total = Number(r.total_time_minutes ?? 0);
            return {
                weekStart: r.week_start,
                prCount: Number(r.pr_count),
                codingTimeMinutes: coding,
                codingTimeHours: Number((coding / 60).toFixed(2)),
                pickupTimeMinutes: pickup,
                pickupTimeHours: Number((pickup / 60).toFixed(2)),
                reviewTimeMinutes: review,
                reviewTimeHours: Number((review / 60).toFixed(2)),
                totalTimeMinutes: total,
                totalTimeHours: Number((total / 60).toFixed(2)),
            };
        });
    }

    async getPullRequestsOpenedVsClosed(
        q: CockpitRangeQuery,
    ): Promise<PullRequestsOpenedVsClosedRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `WITH opened AS (
                SELECT date_trunc('week', pr.parsed_created_at) AS week_start,
                       COUNT(*)::int AS opened_count
                  FROM "analytics"."pull_requests_opt" pr
                 WHERE pr."createdAt" IS NOT NULL
                   AND pr.parsed_created_at >= $2::timestamptz
                   AND pr.parsed_created_at <= $3::timestamptz
                   AND pr."organizationId" = $1
                   ${repoFilter}
                 GROUP BY date_trunc('week', pr.parsed_created_at)
            ),
            closed AS (
                SELECT date_trunc('week', pr.parsed_closed_at) AS week_start,
                       COUNT(*)::int AS closed_count
                  FROM "analytics"."pull_requests_opt" pr
                 WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                   AND pr."status" = 'closed'
                   AND pr.parsed_closed_at >= $2::timestamptz
                   AND pr.parsed_closed_at <= $3::timestamptz
                   AND pr."organizationId" = $1
                   ${repoFilter}
                 GROUP BY date_trunc('week', pr.parsed_closed_at)
            )
            SELECT to_char(COALESCE(o.week_start, c.week_start), 'YYYY-MM-DD') AS week_start,
                   COALESCE(o.opened_count, 0) AS opened_count,
                   COALESCE(c.closed_count, 0) AS closed_count,
                   CASE WHEN COALESCE(o.opened_count, 0) = 0 THEN 0
                        ELSE COALESCE(c.closed_count, 0)::numeric / o.opened_count
                   END AS ratio
              FROM opened o
              FULL OUTER JOIN closed c ON o.week_start = c.week_start
             ORDER BY week_start`,
            params,
        )) as Array<{
            week_start: string;
            opened_count: number;
            closed_count: number;
            ratio: number | string | null;
        }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            openedCount: Number(r.opened_count),
            closedCount: Number(r.closed_count),
            ratio: Number(Number(r.ratio ?? 0).toFixed(2)),
        }));
    }

    async getDeveloperActivity(
        q: CockpitRangeQuery,
    ): Promise<DeveloperActivityRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT to_char(date_trunc('day', pr.parsed_created_at), 'YYYY-MM-DD') AS activity_date,
                    pr.author_username AS developer,
                    COUNT(*)::int AS pr_count
               FROM "analytics"."pull_requests_opt" pr
              WHERE pr.parsed_created_at BETWEEN $2::timestamptz AND $3::timestamptz
                AND pr."organizationId" = $1
                AND pr.author_username IS NOT NULL
                AND btrim(pr.author_username) <> ''
                ${repoFilter}
              GROUP BY activity_date, pr.author_username
              HAVING COUNT(*) > 0
              ORDER BY pr.author_username ASC, activity_date ASC`,
            params,
        )) as Array<{
            activity_date: string;
            developer: string;
            pr_count: number;
        }>;

        return rows.map((r) => ({
            developer: r.developer,
            date: r.activity_date,
            prCount: Number(r.pr_count),
        }));
    }

    async getCompanyDashboard(q: CockpitRangeQuery): Promise<CompanyDashboard> {
        assertIsoDate(q.startDate, 'startDate');
        assertIsoDate(q.endDate, 'endDate');

        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';

        const [
            metricsRows,
            suggestionsRows,
            topCategoriesRows,
            topDevRows,
            rankingRows,
        ] = await Promise.all([
            this.ds.query(
                `SELECT COUNT(*)::int AS total_prs
                   FROM "analytics"."pull_requests_opt" pr
                  WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr."status" = 'closed'
                    AND pr.parsed_closed_at >= $2::timestamptz
                    AND pr.parsed_closed_at <= $3::timestamptz
                    AND pr."organizationId" = $1
                    ${repoFilter}`,
                params,
            ),
            this.ds.query(
                `SELECT COUNT(*)::int AS total_suggestions,
                        COUNT(*) FILTER (WHERE s.severity = 'critical')::int AS critical_suggestions
                   FROM "analytics"."suggestions_mv" s
                   JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
                  WHERE pr."organizationId" = $1
                    AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr.parsed_closed_at >= $2::timestamptz
                    AND pr.parsed_closed_at <= $3::timestamptz
                    AND s."suggestionDeliveryStatus" = 'sent'
                    ${repoFilter}`,
                params,
            ),
            this.ds.query(
                `SELECT s.label AS category, COUNT(*)::int AS count
                   FROM "analytics"."suggestions_mv" s
                   JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
                  WHERE pr."organizationId" = $1
                    AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr.parsed_closed_at >= $2::timestamptz
                    AND pr.parsed_closed_at <= $3::timestamptz
                    AND s."suggestionDeliveryStatus" = 'sent'
                    AND s.label IS NOT NULL
                    ${repoFilter}
                  GROUP BY s.label
                  ORDER BY count DESC
                  LIMIT 3`,
                params,
            ),
            this.ds.query(
                `SELECT pr.author_username AS author, COUNT(*)::int AS pr_count
                   FROM "analytics"."pull_requests_opt" pr
                  WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                    AND pr."status" = 'closed'
                    AND pr.parsed_closed_at >= $2::timestamptz
                    AND pr.parsed_closed_at <= $3::timestamptz
                    AND pr."organizationId" = $1
                    AND pr.author_username IS NOT NULL
                    AND btrim(pr.author_username) <> ''
                    ${repoFilter}
                  GROUP BY pr.author_username
                  ORDER BY pr_count DESC
                  LIMIT 1`,
                params,
            ),
            this.ds.query(
                `WITH ranked AS (
                    SELECT pr."organizationId" AS org_id,
                           COUNT(*)::int AS company_prs,
                           ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
                      FROM "analytics"."pull_requests_opt" pr
                     WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                       AND pr."status" = 'closed'
                       AND pr.parsed_closed_at >= $2::timestamptz
                       AND pr.parsed_closed_at <= $3::timestamptz
                     GROUP BY pr."organizationId"
                )
                SELECT
                    (SELECT COUNT(*)::int FROM "analytics"."pull_requests_opt" pr
                       WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                         AND pr."status" = 'closed'
                         AND pr.parsed_closed_at >= $2::timestamptz
                         AND pr.parsed_closed_at <= $3::timestamptz) AS total_prs_all_companies,
                    (SELECT COUNT(*)::int FROM ranked) AS total_companies,
                    COALESCE((SELECT rank FROM ranked WHERE org_id = $1), 0) AS company_rank`,
                [q.organizationId, q.startDate, q.endDate],
            ),
        ]);

        const metricsRow =
            (metricsRows as Array<{ total_prs: number }>)[0] ?? {
                total_prs: 0,
            };
        const sugRow =
            (suggestionsRows as Array<{
                total_suggestions: number;
                critical_suggestions: number;
            }>)[0] ?? { total_suggestions: 0, critical_suggestions: 0 };
        const topCats = (
            topCategoriesRows as Array<{ category: string; count: number }>
        ).map<SuggestionCategoryCount>((r) => ({
            category: r.category,
            count: Number(r.count),
        }));
        const topDev = (
            topDevRows as Array<{ author: string; pr_count: number }>
        )[0];
        const ranking =
            (
                rankingRows as Array<{
                    total_prs_all_companies: number;
                    total_companies: number;
                    company_rank: number;
                }>
            )[0] ?? {
                total_prs_all_companies: 0,
                total_companies: 0,
                company_rank: 0,
            };

        const totalPRs = Number(metricsRow.total_prs);
        const percentage =
            ranking.total_prs_all_companies > 0
                ? Number(
                      (
                          (totalPRs / ranking.total_prs_all_companies) *
                          100
                      ).toFixed(2),
                  )
                : 0;

        return {
            organizationId: q.organizationId,
            period: { startDate: q.startDate, endDate: q.endDate },
            metrics: {
                totalPRs,
                criticalSuggestions: Number(sugRow.critical_suggestions),
                totalSuggestions: Number(sugRow.total_suggestions),
                topSuggestionsCategories: topCats,
                topDeveloper: {
                    name: topDev?.author ?? 'N/A',
                    totalPRs: topDev ? Number(topDev.pr_count) : 0,
                },
                companyRanking: {
                    rank: Number(ranking.company_rank),
                    totalCompanies: Number(ranking.total_companies),
                    percentageOfTotalPRs: percentage,
                    totalPRsAllCompanies: Number(
                        ranking.total_prs_all_companies,
                    ),
                },
            },
            additionalMetrics: {},
        };
    }

    async getCompanyDashboardInsights(
        q: CockpitRangeQuery,
    ): Promise<CompanyDashboard> {
        const [
            base,
            implementationRate,
            cycleTime,
            deployFrequency,
            bugRatio,
            leadTimeBreakdown,
        ] = await Promise.all([
            this.getCompanyDashboard(q),
            this.codeHealth.getImplementationRate({
                organizationId: q.organizationId,
                repository: q.repository,
                startDate: q.startDate,
                endDate: q.endDate,
            }),
            this.getLeadTimeHighlight(q),
            this.getDeployFrequencyHighlight(q),
            this.codeHealth.getBugRatioHighlight(q),
            this.getLeadTimeBreakdown(q),
        ]);

        return {
            ...base,
            additionalMetrics: {
                suggestionsAppliedPercentage: implementationRate.implementationRate,
                suggestionsImplementedCount: implementationRate.suggestionsImplemented,
                cycleTime,
                deployFrequency,
                bugRatio,
                leadTimeBreakdown,
            },
        };
    }
}
