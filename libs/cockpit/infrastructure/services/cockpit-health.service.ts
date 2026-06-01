import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

export interface CockpitHealth {
    status: 'ok' | 'degraded';
    analyticsPostgres: {
        reachable: boolean;
        schema: string | null;
        error?: string;
    };
}

export interface IngestionRunSummary {
    id: string;
    source: string;
    mode: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    scanned: number;
    prsUpserted: number;
    suggestionsInserted: number;
    commitsInserted: number;
    errorsQuarantined: number;
    mongoMs: number | null;
    writeMs: number | null;
    error: string | null;
}

export interface IngestionRunsHealth {
    /** Most recent run regardless of status. */
    last: IngestionRunSummary | null;
    /** Most recent successful (`ok` or `partial`) run. */
    lastOk: IngestionRunSummary | null;
    /** Hours since last successful run. `null` if never succeeded. */
    lagHours: number | null;
    /** Failed runs in the last 24h (alerting input). */
    failedLast24h: number;
    /** Quarantine count in the last 24h (drift watch). */
    quarantinedLast24h: number;
}

/**
 * Smoke-check for the analytics warehouse connection. Used by the
 * `/cockpit/health` endpoint so we can tell at a glance — from either
 * cloud or self-hosted — whether the warehouse is wired correctly.
 */
@Injectable()
export class CockpitHealthService {
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly analyticsDataSource: DataSource,
    ) {}

    async ping(): Promise<CockpitHealth> {
        try {
            const schema =
                (this.analyticsDataSource.options as { schema?: string })
                    .schema ?? null;

            await this.analyticsDataSource.query('SELECT 1');

            return {
                status: 'ok',
                analyticsPostgres: { reachable: true, schema },
            };
        } catch (err) {
            return {
                status: 'degraded',
                analyticsPostgres: {
                    reachable: false,
                    schema: null,
                    error: err instanceof Error ? err.message : String(err),
                },
            };
        }
    }

    /**
     * Snapshot of ingestion health: last run, lag since last success,
     * failure / quarantine counts in the last 24h. Designed to be polled
     * by an external alert (e.g. BetterStack) or rendered on a status
     * page. Self-hosted operators can curl this to see if the warehouse
     * is keeping up.
     */
    async runsSummary(source = 'pull_requests'): Promise<IngestionRunsHealth> {
        const last = await this.fetchLast(source, undefined);
        const lastOk = await this.fetchLast(source, ['ok', 'partial']);
        const lagHours = lastOk?.finishedAt
            ? Math.max(
                  0,
                  (Date.now() - lastOk.finishedAt.getTime()) / 3_600_000,
              )
            : null;

        const counts = (await this.analyticsDataSource.query(
            `SELECT
                COUNT(*) FILTER (WHERE "status" = 'failed') AS failed,
                COALESCE(SUM("errors_quarantined"), 0) AS quarantined
             FROM "analytics"."ingestion_runs"
             WHERE "source" = $1
               AND "started_at" >= now() - INTERVAL '24 hours'`,
            [source],
        )) as Array<{ failed: string | number; quarantined: string | number }>;

        return {
            last,
            lastOk,
            lagHours,
            failedLast24h: Number(counts[0]?.failed ?? 0),
            quarantinedLast24h: Number(counts[0]?.quarantined ?? 0),
        };
    }

    private async fetchLast(
        source: string,
        statuses: string[] | undefined,
    ): Promise<IngestionRunSummary | null> {
        const params: unknown[] = [source];
        let where = `"source" = $1`;
        if (statuses && statuses.length) {
            params.push(statuses);
            where += ` AND "status" = ANY($${params.length}::text[])`;
        }
        const rows = (await this.analyticsDataSource.query(
            `SELECT "id", "source", "mode", "status", "started_at",
                    "finished_at", "scanned", "prs_upserted",
                    "suggestions_inserted", "commits_inserted",
                    "errors_quarantined", "mongo_ms", "write_ms", "error"
             FROM "analytics"."ingestion_runs"
             WHERE ${where}
             ORDER BY "started_at" DESC
             LIMIT 1`,
            params,
        )) as Array<{
            id: string | number;
            source: string;
            mode: string;
            status: string;
            started_at: Date | null;
            finished_at: Date | null;
            scanned: number;
            prs_upserted: number;
            suggestions_inserted: number;
            commits_inserted: number;
            errors_quarantined: number;
            mongo_ms: number | null;
            write_ms: number | null;
            error: string | null;
        }>;

        if (!rows.length) return null;
        const r = rows[0];
        return {
            id: String(r.id),
            source: r.source,
            mode: r.mode,
            status: r.status,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            scanned: r.scanned,
            prsUpserted: r.prs_upserted,
            suggestionsInserted: r.suggestions_inserted,
            commitsInserted: r.commits_inserted,
            errorsQuarantined: r.errors_quarantined,
            mongoMs: r.mongo_ms,
            writeMs: r.write_ms,
            error: r.error,
        };
    }
}
