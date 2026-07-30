import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '../schema.constant';

export const REVIEW_OPERATIONAL_INGESTION_WATERMARK =
    'review_operational_executions';
export const REVIEW_OPERATIONAL_INGESTION_SOURCE =
    'review_operational_executions';

const TERMINAL_REVIEW_STATUSES = [
    'success',
    'error',
    'partial_error',
    'skipped',
] as const;

// Inlined as enum literals (not a `status::text = ANY($n)` param) so the
// predicate matches `IDX_automation_exec_review_ops_watermark`'s partial index
// condition verbatim — otherwise the planner can't prove the match and falls
// back to a full seq scan + on-disk sort (~50x slower on the backfill).
const TERMINAL_REVIEW_STATUS_SQL = TERMINAL_REVIEW_STATUSES.map(
    (status) => `'${status}'`,
).join(', ');

/**
 * Hard cap on how far back the import reaches. The cockpit date picker tops out
 * at a 3-month range and every metric compares it against the equally-long
 * previous period, so 6 months is the deepest window any read can touch.
 * Capping here keeps the first (watermark-less) backfill from scanning and
 * materializing the entire historical `automation_execution` corpus.
 */
const REVIEW_BACKFILL_WINDOW = '6 months';

interface ReviewOperationalSourceRow {
    automation_execution_id: string;
    organization_id: string;
    team_id: string | null;
    team_automation_id: string | null;
    repository_id: string | null;
    repo_full_name: string | null;
    pull_request_number: number | string | null;
    status: string;
    created_at: Date;
    source_updated_at: string;
}

export interface ReviewOperationalIngestionOptions {
    /** Scope to one org for replay/admin tooling. */
    organizationId?: string;
    /** Ignore the watermark and rescan everything. */
    backfill?: boolean;
    batchSize?: number;
}

export interface ReviewOperationalIngestionResult {
    scanned: number;
    upserted: number;
    newWatermark: string | null;
    durationMs: number;
}

/**
 * Incremental sync of terminal code-review automation executions from OLTP
 * Postgres into `analytics.review_operational_executions`.
 *
 * First run has no watermark, so it imports the historical corpus. Later
 * runs advance via `(updatedAt, uuid)` and only pull changes.
 */
@Injectable()
export class ReviewOperationalIngestionService {
    private readonly logger = new Logger(
        ReviewOperationalIngestionService.name,
    );

    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly analyticsDs: DataSource,
        @InjectDataSource()
        private readonly appDs: DataSource,
    ) {}

    async run(
        options: ReviewOperationalIngestionOptions = {},
    ): Promise<ReviewOperationalIngestionResult> {
        const batchSize = options.batchSize ?? 500;
        const useWatermark = !options.backfill;
        let watermark = useWatermark ? await this.readWatermark() : null;

        const startedAt = Date.now();
        const runId = await this.startRun(options.organizationId ?? null);

        let scanned = 0;
        let upserted = 0;
        let newestUpdatedAt: string | null = watermark?.updatedAt ?? null;
        let newestId: string | null;

        try {
            while (true) {
                const rows = await this.fetchBatch(
                    watermark,
                    options.organizationId,
                    batchSize,
                );
                if (!rows.length) break;

                scanned += rows.length;
                upserted += await this.writeBatch(rows);

                const last = rows[rows.length - 1];
                newestUpdatedAt = last.source_updated_at;
                newestId = last.automation_execution_id;
                watermark = {
                    updatedAt: newestUpdatedAt,
                    id: newestId,
                };

                if (useWatermark && newestUpdatedAt) {
                    await this.writeWatermark(newestUpdatedAt, newestId);
                }

                if (rows.length < batchSize) break;
            }

            const durationMs = Date.now() - startedAt;
            await this.completeRun(runId, 'ok', scanned, upserted, null);
            this.logger.log(
                `review operational ingestion done: scanned=${scanned} upserted=${upserted} ` +
                    `total_ms=${durationMs} watermark=${newestUpdatedAt ?? 'null'}`,
            );

            return {
                scanned,
                upserted,
                newWatermark: newestUpdatedAt,
                durationMs,
            };
        } catch (err) {
            await this.completeRun(
                runId,
                'failed',
                scanned,
                upserted,
                err instanceof Error ? err.message : String(err),
            );
            throw err;
        }
    }

    private async fetchBatch(
        watermark: { updatedAt: string; id: string | null } | null,
        organizationId: string | undefined,
        batchSize: number,
    ): Promise<ReviewOperationalSourceRow[]> {
        const params: unknown[] = [batchSize];
        const orgFilter = organizationId
            ? (params.push(organizationId),
              `AND t."organization_id" = $${params.length}`)
            : '';

        let cursorFilter = '';
        if (watermark?.updatedAt) {
            params.push(watermark.updatedAt);
            const updatedAtIndex = params.length;
            if (watermark.id) {
                params.push(watermark.id);
                cursorFilter = `AND (
                    ae."updatedAt" > $${updatedAtIndex}::timestamp
                    OR (
                        ae."updatedAt" = $${updatedAtIndex}::timestamp
                        AND ae."uuid" > $${params.length}::uuid
                    )
                )`;
            } else {
                cursorFilter = `AND ae."updatedAt" > $${updatedAtIndex}::timestamp`;
            }
        }

        return (await this.appDs.query(
            `SELECT
                    ae."uuid" AS automation_execution_id,
                    t."organization_id"::text AS organization_id,
                    t."uuid" AS team_id,
                    ae."team_automation_id" AS team_automation_id,
                    ae."repositoryId"::text AS repository_id,
                    COALESCE(
                        repo."full_name",
                        ae."dataExecution"->'repository'->>'fullName',
                        ae."dataExecution"->'repository'->>'name'
                    )::text AS repo_full_name,
                    ae."pullRequestNumber" AS pull_request_number,
                    ae."status"::text AS status,
                    ae."createdAt" AS created_at,
                    to_char(ae."updatedAt", 'YYYY-MM-DD HH24:MI:SS.US') AS source_updated_at
                  FROM "automation_execution" ae
                  JOIN "team_automations" ta
                    ON ta."uuid" = ae."team_automation_id"
                  JOIN "teams" t
                    ON t."uuid" = ta."teamUuid"
                  LEFT JOIN LATERAL (
                      SELECT r."full_name"
                        FROM "repositories" r
                       WHERE r."external_id" = ae."repositoryId"
                       ORDER BY r."createdAt" DESC
                       LIMIT 1
                  ) repo ON true
                 WHERE ae."status" IN (${TERMINAL_REVIEW_STATUS_SQL})
                   AND ae."pullRequestNumber" IS NOT NULL
                   AND ae."repositoryId" IS NOT NULL
                   -- 6-month floor: bounds the historical backfill. updatedAt
                   -- is floored too (updatedAt >= createdAt always holds) so
                   -- the (updatedAt, uuid) index can seek to the cutoff
                   -- instead of scanning the table from its oldest row.
                   AND ae."createdAt" >= now() - INTERVAL '${REVIEW_BACKFILL_WINDOW}'
                   AND ae."updatedAt" >= now() - INTERVAL '${REVIEW_BACKFILL_WINDOW}'
                   AND EXISTS (
                       SELECT 1
                         FROM "code_review_execution" cre
                        WHERE cre."automation_execution_id" = ae."uuid"
                   )
                   ${orgFilter}
                   ${cursorFilter}
             ORDER BY ae."updatedAt" ASC, ae."uuid" ASC
             LIMIT $1`,
            params,
        )) as ReviewOperationalSourceRow[];
    }

    private async writeBatch(
        rows: ReviewOperationalSourceRow[],
    ): Promise<number> {
        if (!rows.length) return 0;

        const params: unknown[] = [];
        const values = rows
            .map((row) => {
                const offset = params.length;
                params.push(
                    row.automation_execution_id,
                    row.organization_id,
                    row.team_id,
                    row.team_automation_id,
                    row.repository_id,
                    row.repo_full_name,
                    row.pull_request_number != null
                        ? Number(row.pull_request_number)
                        : null,
                    row.status,
                    row.created_at,
                    row.source_updated_at,
                );
                return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
            })
            .join(', ');

        await this.analyticsDs.transaction(async (manager) => {
            await manager.query(
                `INSERT INTO "analytics"."review_operational_executions" (
                        "automation_execution_id", "organizationId",
                        "team_id", "team_automation_id",
                        "repositoryId", "repo_full_name", "pullRequestNumber",
                        "status", "created_at", "source_updated_at"
                     ) VALUES ${values}
                     ON CONFLICT ("automation_execution_id") DO UPDATE SET
                        "organizationId" = EXCLUDED."organizationId",
                        "team_id" = EXCLUDED."team_id",
                        "team_automation_id" = EXCLUDED."team_automation_id",
                        "repositoryId" = EXCLUDED."repositoryId",
                        "repo_full_name" = EXCLUDED."repo_full_name",
                        "pullRequestNumber" = EXCLUDED."pullRequestNumber",
                        "status" = EXCLUDED."status",
                        "created_at" = EXCLUDED."created_at",
                        "source_updated_at" = EXCLUDED."source_updated_at",
                        "ingested_at" = now()`,
                params,
            );
        });
        return rows.length;
    }

    async readWatermark(): Promise<{
        updatedAt: string;
        id: string | null;
    } | null> {
        const rows = (await this.analyticsDs.query(
            `SELECT
                to_char("last_source_updated_at", 'YYYY-MM-DD HH24:MI:SS.US') AS "last_source_updated_at",
                "last_source_id"
             FROM "analytics"."watermarks" WHERE "table_name" = $1`,
            [REVIEW_OPERATIONAL_INGESTION_WATERMARK],
        )) as Array<{
            last_source_updated_at: string | null;
            last_source_id: string | null;
        }>;
        const row = rows[0];
        if (!row?.last_source_updated_at) return null;
        return {
            updatedAt: row.last_source_updated_at,
            id: row.last_source_id ?? null,
        };
    }

    private async writeWatermark(
        at: string | Date,
        id: string | null,
    ): Promise<void> {
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."watermarks" (
                "table_name", "last_source_updated_at", "last_source_id",
                "last_run_at", "last_status", "last_error"
             ) VALUES ($1, $2, $3, now(), 'ok', NULL)
             ON CONFLICT ("table_name") DO UPDATE SET
                "last_source_updated_at" = CASE
                    WHEN EXCLUDED."last_source_updated_at" > COALESCE(
                        "analytics"."watermarks"."last_source_updated_at",
                        'epoch'::timestamptz
                    )
                    THEN EXCLUDED."last_source_updated_at"
                    WHEN EXCLUDED."last_source_updated_at" = "analytics"."watermarks"."last_source_updated_at"
                     AND COALESCE(EXCLUDED."last_source_id", '') > COALESCE(
                        "analytics"."watermarks"."last_source_id",
                        ''
                     )
                    THEN EXCLUDED."last_source_updated_at"
                    ELSE "analytics"."watermarks"."last_source_updated_at"
                END,
                "last_source_id" = CASE
                    WHEN EXCLUDED."last_source_updated_at" > COALESCE(
                        "analytics"."watermarks"."last_source_updated_at",
                        'epoch'::timestamptz
                    )
                    THEN EXCLUDED."last_source_id"
                    WHEN EXCLUDED."last_source_updated_at" = "analytics"."watermarks"."last_source_updated_at"
                     AND COALESCE(EXCLUDED."last_source_id", '') > COALESCE(
                        "analytics"."watermarks"."last_source_id",
                        ''
                     )
                    THEN EXCLUDED."last_source_id"
                    ELSE "analytics"."watermarks"."last_source_id"
                END,
                "last_run_at" = now(),
                "last_status" = EXCLUDED."last_status",
                "last_error" = NULL`,
            [REVIEW_OPERATIONAL_INGESTION_WATERMARK, at, id],
        );
    }

    private async startRun(
        organizationId: string | null,
    ): Promise<string | null> {
        try {
            const rows = (await this.analyticsDs.query(
                `INSERT INTO "analytics"."ingestion_runs" (
                    "source", "mode", "status", "organizationId"
                 ) VALUES ($1, 'incremental', 'running', $2)
                 RETURNING "id"`,
                [REVIEW_OPERATIONAL_INGESTION_SOURCE, organizationId],
            )) as Array<{ id: string | number }>;
            return rows[0]?.id != null ? String(rows[0].id) : null;
        } catch {
            return null;
        }
    }

    private async completeRun(
        runId: string | null,
        status: 'ok' | 'failed',
        scanned: number,
        upserted: number,
        error: string | null,
    ): Promise<void> {
        if (!runId) return;
        try {
            await this.analyticsDs.query(
                `UPDATE "analytics"."ingestion_runs"
                    SET "status" = $2, "finished_at" = now(),
                        "scanned" = $3, "prs_upserted" = $4, "error" = $5
                  WHERE "id" = $1`,
                [runId, status, scanned, upserted, error],
            );
        } catch {
            // auxiliary table - never fail the run because of it
        }
    }
}
