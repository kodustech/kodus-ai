import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectDataSource } from '@nestjs/typeorm';
import { Model, Types } from 'mongoose';
import { DataSource } from 'typeorm';

import { CodeReviewFeedbackModel } from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/codeReviewFeedback.model';

import { ANALYTICS_DATA_SOURCE } from '../schema.constant';
import { parseTimestamp } from './parse-timestamps.util';

export const FEEDBACK_INGESTION_WATERMARK = 'code_review_feedback';
export const FEEDBACK_INGESTION_SOURCE = 'code_review_feedback';

export interface FeedbackIngestionOptions {
    /** Scope to one org (admin/replay tooling). */
    organizationId?: string;
    /** Ignore the watermark and rescan everything. */
    backfill?: boolean;
    batchSize?: number;
}

export interface FeedbackIngestionResult {
    scanned: number;
    upserted: number;
    newWatermark: Date | null;
    durationMs: number;
}

/**
 * Incremental sync of Mongo `codeReviewFeedback` (thumbs up/down reactions
 * on suggestion comments) into `analytics.suggestion_feedback`.
 *
 * Same tuple-watermark discipline as `PullRequestIngestionService`, much
 * smaller surface: flat docs, absolute counters (the review pipeline
 * re-reads reactions from the provider), so a plain upsert per doc is
 * fully idempotent.
 */
@Injectable()
export class FeedbackIngestionService {
    private readonly logger = new Logger(FeedbackIngestionService.name);

    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly analyticsDs: DataSource,
        @InjectModel(CodeReviewFeedbackModel.name)
        private readonly feedbackModel: Model<CodeReviewFeedbackModel>,
    ) {}

    async run(
        options: FeedbackIngestionOptions = {},
    ): Promise<FeedbackIngestionResult> {
        const batchSize = options.batchSize ?? 500;
        const useWatermark = !options.backfill;
        const watermark = useWatermark ? await this.readWatermark() : null;

        const filter: Record<string, unknown> = {};
        if (options.organizationId) {
            if (typeof options.organizationId !== 'string') {
                throw new Error(
                    'organizationId must be a string, not an object',
                );
            }
            filter.organizationId = options.organizationId;
        }
        if (watermark) {
            if (watermark.id) {
                filter.$or = [
                    { updatedAt: { $gt: watermark.updatedAt } },
                    {
                        updatedAt: watermark.updatedAt,
                        _id: { $gt: this.toObjectIdOrString(watermark.id) },
                    },
                ];
            } else {
                filter.updatedAt = { $gt: watermark.updatedAt };
            }
        }

        const cursor = this.feedbackModel
            .find(filter)
            .read('secondaryPreferred')
            .sort({ updatedAt: 1, _id: 1 })
            .lean()
            .cursor({ batchSize });

        const startedAt = Date.now();
        const runId = await this.startRun(options.organizationId ?? null);

        let scanned = 0;
        let upserted = 0;
        let newestUpdatedAt: Date | null = watermark?.updatedAt ?? null;
        let newestId: string | null = watermark?.id ?? null;

        try {
            const buffer: Array<Record<string, unknown>> = [];
            const flush = async () => {
                if (!buffer.length) return;
                upserted += await this.writeBatch(buffer);
                buffer.length = 0;
            };

            for await (const doc of cursor) {
                scanned += 1;
                buffer.push(doc as unknown as Record<string, unknown>);

                const asDate = parseTimestamp(
                    (doc as { updatedAt?: unknown }).updatedAt,
                );
                const docId = (doc as { _id?: unknown })._id;
                if (asDate) {
                    if (!newestUpdatedAt || asDate > newestUpdatedAt) {
                        newestUpdatedAt = asDate;
                        newestId = docId != null ? String(docId) : null;
                    } else if (
                        asDate.getTime() === newestUpdatedAt.getTime() &&
                        docId != null
                    ) {
                        newestId = String(docId);
                    }
                }

                if (buffer.length >= batchSize) await flush();
            }
            await flush();

            if (useWatermark && scanned > 0 && newestUpdatedAt) {
                await this.writeWatermark(newestUpdatedAt, newestId);
            }

            const durationMs = Date.now() - startedAt;
            await this.completeRun(runId, 'ok', scanned, upserted, null);
            this.logger.log(
                `feedback ingestion done: scanned=${scanned} upserted=${upserted} ` +
                    `total_ms=${durationMs} watermark=${newestUpdatedAt?.toISOString() ?? 'null'}`,
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

    private async writeBatch(
        docs: Array<Record<string, unknown>>,
    ): Promise<number> {
        let written = 0;
        await this.analyticsDs.transaction(async (manager) => {
            for (const raw of docs) {
                const doc = raw as unknown as CodeReviewFeedbackModel & {
                    updatedAt?: unknown;
                    createdAt?: unknown;
                };
                if (!doc.suggestionId) continue;
                await manager.query(
                    `INSERT INTO "analytics"."suggestion_feedback" (
                        "suggestion_id", "organizationId",
                        "thumbs_up", "thumbs_down",
                        "comment_id", "pull_request_id", "repo_full_name",
                        "feedback_created_at", "source_updated_at"
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT ("suggestion_id") DO UPDATE SET
                        "thumbs_up" = EXCLUDED."thumbs_up",
                        "thumbs_down" = EXCLUDED."thumbs_down",
                        "comment_id" = EXCLUDED."comment_id",
                        "pull_request_id" = EXCLUDED."pull_request_id",
                        "repo_full_name" = EXCLUDED."repo_full_name",
                        "feedback_created_at" = EXCLUDED."feedback_created_at",
                        "source_updated_at" = EXCLUDED."source_updated_at",
                        "ingested_at" = now()`,
                    [
                        doc.suggestionId,
                        doc.organizationId,
                        doc.reactions?.thumbsUp ?? 0,
                        doc.reactions?.thumbsDown ?? 0,
                        typeof doc.comment?.id === 'number'
                            ? doc.comment.id
                            : null,
                        doc.pullRequest?.id != null
                            ? String(doc.pullRequest.id)
                            : null,
                        doc.pullRequest?.repository?.fullName ?? null,
                        parseTimestamp(doc.createdAt),
                        parseTimestamp(doc.updatedAt),
                    ],
                );
                written += 1;
            }
        });
        return written;
    }

    async readWatermark(): Promise<{
        updatedAt: Date;
        id: string | null;
    } | null> {
        const rows = (await this.analyticsDs.query(
            `SELECT "last_source_updated_at", "last_source_id"
             FROM "analytics"."watermarks" WHERE "table_name" = $1`,
            [FEEDBACK_INGESTION_WATERMARK],
        )) as Array<{
            last_source_updated_at: Date | null;
            last_source_id: string | null;
        }>;
        const row = rows[0];
        if (!row?.last_source_updated_at) return null;
        return {
            updatedAt: row.last_source_updated_at,
            id: row.last_source_id ?? null,
        };
    }

    private async writeWatermark(at: Date, id: string | null): Promise<void> {
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."watermarks" (
                "table_name", "last_source_updated_at", "last_source_id",
                "last_run_at", "last_status", "last_error"
             ) VALUES ($1, $2, $3, now(), 'ok', NULL)
             ON CONFLICT ("table_name") DO UPDATE SET
                "last_source_updated_at" = GREATEST(
                    EXCLUDED."last_source_updated_at",
                    "analytics"."watermarks"."last_source_updated_at"
                ),
                "last_source_id" = CASE
                    WHEN EXCLUDED."last_source_updated_at" >= COALESCE(
                        "analytics"."watermarks"."last_source_updated_at",
                        'epoch'::timestamptz
                    )
                    THEN EXCLUDED."last_source_id"
                    ELSE "analytics"."watermarks"."last_source_id"
                END,
                "last_run_at" = now(),
                "last_status" = EXCLUDED."last_status",
                "last_error" = NULL`,
            [FEEDBACK_INGESTION_WATERMARK, at, id],
        );
    }

    private toObjectIdOrString(id: string): Types.ObjectId | string {
        if (Types.ObjectId.isValid(id)) {
            try {
                return new Types.ObjectId(id);
            } catch {
                return id;
            }
        }
        return id;
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
                [FEEDBACK_INGESTION_SOURCE, organizationId],
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
            // auxiliary table — never fail the run because of it
        }
    }
}
