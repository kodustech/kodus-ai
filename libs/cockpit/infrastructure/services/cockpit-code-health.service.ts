import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

import {
    computePreviousPeriod,
    computeTrend,
} from '../../application/date-range.util';
import {
    BugRatioHighlight,
    BugRatioRow,
    CockpitRangeQuery,
    RepositorySuggestions,
    SuggestionCategoryCount,
    SuggestionsImplementationRate,
} from '../../domain/types';

/**
 * Postgres port of `kodus-service-analytics/src/services/analytics/code-health.service.ts`.
 *
 * Notes on the port:
 *  - Suggestion aggregations read from `analytics.suggestions_mv` (flat),
 *    not from `files[].suggestions[]` JSON. The ingestion worker is the
 *    one that flattens.
 *  - Bug ratio still joins `pull_request_types`; until a classifier
 *    populates that table, bug-fix counts are zero, which matches legacy
 *    behavior for orgs without classification.
 */
@Injectable()
export class CockpitCodeHealthService {
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
    ) {}

    async getSuggestionsByCategory(
        q: CockpitRangeQuery,
    ): Promise<SuggestionCategoryCount[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository), `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT COALESCE(s.label, 'Unknown') AS category,
                    COUNT(*)::int AS count
               FROM "analytics"."suggestions_mv" s
               JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
              WHERE pr."organizationId" = $1
                AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
                AND s."suggestionDeliveryStatus" = 'sent'
                ${repoFilter}
              GROUP BY category
              ORDER BY count DESC`,
            params,
        )) as Array<{ category: string; count: number }>;

        return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
    }

    async getSuggestionsByRepository(
        q: CockpitRangeQuery,
    ): Promise<RepositorySuggestions[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository), `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `WITH repo_suggestions AS (
                SELECT
                    COALESCE(pr.repo_full_name, 'Unknown') AS repository,
                    COALESCE(s.label, 'Unknown') AS category,
                    COUNT(*)::int AS count
                FROM "analytics"."suggestions_mv" s
                JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
                WHERE pr."organizationId" = $1
                  AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                  AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
                  AND s."suggestionDeliveryStatus" = 'sent'
                  ${repoFilter}
                GROUP BY repository, category
            )
            SELECT repository,
                   jsonb_agg(jsonb_build_object('category', category, 'count', count) ORDER BY count DESC) AS categories,
                   SUM(count)::int AS total_count
              FROM repo_suggestions
             GROUP BY repository
             ORDER BY total_count DESC`,
            params,
        )) as Array<{
            repository: string;
            categories: SuggestionCategoryCount[];
            total_count: number;
        }>;

        return rows.map((row) => ({
            repository: row.repository,
            totalCount: Number(row.total_count),
            categories: (row.categories ?? []).map((c) => ({
                category: c.category,
                count: Number(c.count),
            })),
        }));
    }

    async getBugRatioChart(q: CockpitRangeQuery): Promise<BugRatioRow[]> {
        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const repoFilter = q.repository
            ? (params.push(q.repository), `AND pr.repo_full_name = $${params.length}`)
            : '';

        const rows = (await this.ds.query(
            `SELECT
                to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                COUNT(*)::int AS total_prs,
                COUNT(*) FILTER (WHERE prt.type = 'Bug Fix')::int AS bug_fix_prs,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE (COUNT(*) FILTER (WHERE prt.type = 'Bug Fix'))::numeric / COUNT(*)
                END AS ratio
             FROM "analytics"."pull_requests_opt" pr
             LEFT JOIN "analytics"."pull_request_types" prt
                    ON pr."_id" = prt."pullRequestId"
             WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
               AND pr."status" = 'closed'
               AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
               AND pr."organizationId" = $1
               ${repoFilter}
             GROUP BY date_trunc('week', pr.parsed_closed_at)
             ORDER BY date_trunc('week', pr.parsed_closed_at) ASC`,
            params,
        )) as Array<{
            week_start: string;
            total_prs: number;
            bug_fix_prs: number;
            ratio: number | string | null;
        }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            totalPRs: Number(r.total_prs),
            bugFixPRs: Number(r.bug_fix_prs),
            ratio: Number(Number(r.ratio ?? 0).toFixed(2)),
        }));
    }

    async getBugRatioHighlight(q: CockpitRangeQuery): Promise<BugRatioHighlight> {
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (start: string, end: string) => {
            const params: unknown[] = [q.organizationId, start, end];
            const repoFilter = q.repository
                ? (params.push(q.repository),
                  `AND pr.repo_full_name = $${params.length}`)
                : '';
            const rows = (await this.ds.query(
                `SELECT
                    COUNT(*)::int AS total_prs,
                    COUNT(*) FILTER (WHERE prt.type = 'Bug Fix')::int AS bug_fix_prs,
                    CASE WHEN COUNT(*) = 0 THEN 0
                         ELSE (COUNT(*) FILTER (WHERE prt.type = 'Bug Fix'))::numeric / COUNT(*)
                    END AS ratio
                 FROM "analytics"."pull_requests_opt" pr
                 LEFT JOIN "analytics"."pull_request_types" prt
                        ON pr."_id" = prt."pullRequestId"
                 WHERE pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                   AND pr."status" = 'closed'
                   AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
                   AND pr."organizationId" = $1
                   ${repoFilter}`,
                params,
            )) as Array<{
                total_prs: number;
                bug_fix_prs: number;
                ratio: number | string | null;
            }>;
            const r = rows[0] ?? { total_prs: 0, bug_fix_prs: 0, ratio: 0 };
            return {
                totalPRs: Number(r.total_prs),
                bugFixPRs: Number(r.bug_fix_prs),
                ratio: Number(r.ratio ?? 0),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        const { percentageChange, trend } = computeTrend(
            current.ratio,
            previous.ratio,
            'down',
        );

        const toPct = (ratio: number) => Number((ratio * 100).toFixed(2));

        return {
            currentPeriod: {
                totalPRs: current.totalPRs,
                bugFixPRs: current.bugFixPRs,
                ratio: toPct(current.ratio),
            },
            previousPeriod: {
                totalPRs: previous.totalPRs,
                bugFixPRs: previous.bugFixPRs,
                ratio: toPct(previous.ratio),
            },
            comparison: { percentageChange, trend },
        };
    }

    async getImplementationRate(
        q: Pick<CockpitRangeQuery, 'organizationId' | 'repository'> &
            Partial<Pick<CockpitRangeQuery, 'startDate' | 'endDate'>>,
    ): Promise<SuggestionsImplementationRate> {
        const params: unknown[] = [q.organizationId];
        const repoFilter = q.repository
            ? (params.push(q.repository), `AND pr.repo_full_name = $${params.length}`)
            : '';

        // When the caller supplies a window, scope both the suggestion and PR
        // populations to PRs closed inside it — the weekly recap needs the
        // numerator (implemented) and denominator (sent) to share the same
        // recap range. Otherwise fall back to the legacy "last 14 days" view
        // used by the cockpit highlight endpoint.
        const hasRange = Boolean(q.startDate && q.endDate);
        let svFilter: string;
        let prFilter: string;
        if (hasRange) {
            params.push(q.startDate, q.endDate);
            const startIdx = params.length - 1;
            const endIdx = params.length;
            svFilter = `s."suggestionDeliveryStatus" = 'sent'`;
            prFilter = `pr."organizationId" = $1
                   AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                   AND pr."status" = 'closed'
                   AND pr.parsed_closed_at >= $${startIdx}::timestamptz
                   AND pr.parsed_closed_at <= $${endIdx}::timestamptz
                   ${repoFilter}`;
        } else {
            svFilter = `s."suggestionDeliveryStatus" = 'sent'
                   AND s."suggestionCreatedAt" >= (now() - interval '14 days')`;
            prFilter = `pr."organizationId" = $1
                   ${repoFilter}`;
        }

        const rows = (await this.ds.query(
            `WITH sv AS (
                SELECT s.*
                  FROM "analytics"."suggestions_mv" s
                 WHERE ${svFilter}
            ),
            pr AS (
                SELECT "_id"
                  FROM "analytics"."pull_requests_opt" pr
                 WHERE ${prFilter}
            )
            SELECT
                COUNT(*)::int AS suggestions_sent,
                SUM(CASE WHEN sv."suggestionImplementationStatus" IN ('implemented','partially_implemented') THEN 1 ELSE 0 END)::int AS suggestions_implemented,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE SUM(CASE WHEN sv."suggestionImplementationStatus" IN ('implemented','partially_implemented') THEN 1 ELSE 0 END)::numeric / COUNT(*)
                END AS implementation_rate
              FROM sv
              JOIN pr ON sv."pullRequestId" = pr."_id"`,
            params,
        )) as Array<{
            suggestions_sent: number;
            suggestions_implemented: number;
            implementation_rate: number | string | null;
        }>;

        const r = rows[0] ?? {
            suggestions_sent: 0,
            suggestions_implemented: 0,
            implementation_rate: 0,
        };

        return {
            suggestionsSent: Number(r.suggestions_sent),
            suggestionsImplemented: Number(r.suggestions_implemented),
            implementationRate: Number(Number(r.implementation_rate ?? 0).toFixed(2)),
        };
    }
}
