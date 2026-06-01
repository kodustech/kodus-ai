import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { PullRequestsModel } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

import { ANALYTICS_DATA_SOURCE } from '../schema.constant';
import {
    PR_INGESTION_SOURCE,
    PullRequestIngestionService,
} from './pull-request-ingestion.service';

function clampPositiveInt(
    value: number | undefined,
    fallback: number,
    max: number,
): number {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
    ) {
        return fallback;
    }
    return Math.min(value, max);
}

function clampNonNegativeInt(
    value: number | undefined,
    fallback: number,
    max: number,
): number {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 0
    ) {
        return fallback;
    }
    return Math.min(value, max);
}

export interface BackfillOptions {
    /** ISO date string, exclusive upper bound. Default = now. */
    until?: string;
    /** ISO date string, inclusive lower bound. Default = oldest createdAt
     * found in Mongo, falling back to '2020-01-01'. */
    from?: string;
    /** Days per window. Default 1. */
    stepDays?: number;
    /** Pause between windows in ms (gives autovacuum/replication air).
     * Default 5000. */
    pauseMs?: number;
    /** Mongo batch per fetch inside each window. Default 200 (smaller than
     * incremental cron's 500 to keep transactions short). */
    batchSize?: number;
    /** Restart from `from` even if a checkpoint exists. */
    fresh?: boolean;
    /** Restrict to a single org (for spot replay). */
    organizationId?: string;
    /** Cooperative cancellation. When aborted, the loop finishes the
     * current window, writes a `paused` checkpoint and returns with
     * `status='paused'`. Re-running with the default `fresh: false`
     * resumes from that checkpoint. ECS stopTimeout caps how long the
     * in-flight window can take before SIGKILL — bump it on the task
     * def if windows routinely exceed 30s. */
    signal?: AbortSignal;
}

export interface BackfillResult {
    startedAt: Date;
    finishedAt: Date;
    windows: number;
    scannedTotal: number;
    upsertedTotal: number;
    finalCursor: Date;
    status: 'completed' | 'paused' | 'failed';
}

const SOURCE = PR_INGESTION_SOURCE;

/**
 * Drives the chunked backfill of `pull_requests` into the warehouse.
 *
 * Strategy: walk the timeline in fixed windows by source `createdAt`
 * (so each PR lands in exactly one window — no double work). Persist a
 * checkpoint to `analytics.backfill_progress` after every window so a
 * crash, OOM, or Ctrl+C resumes from where we stopped.
 *
 * Watermark side-effect: chunked windows DO NOT touch the incremental
 * watermark (`PullRequestIngestionService` honors that). On final
 * completion this orchestrator seeds the watermark to the latest
 * `updatedAt` it observed, so the daily cron picks up cleanly.
 */
@Injectable()
export class BackfillOrchestratorService {
    private readonly logger = new Logger(BackfillOrchestratorService.name);

    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly analyticsDs: DataSource,
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<PullRequestsModel>,
        private readonly ingestion: PullRequestIngestionService,
    ) {}

    async run(options: BackfillOptions = {}): Promise<BackfillResult> {
        // Defense-in-depth. The admin HTTP endpoint already rejects
        // non-positive values, but other callers (CLI, cron, internal
        // hand-off) land here with whatever they want — and CodeQL
        // tracks the flow of the query param all the way into the
        // setTimeout below. Cap everything to sane bounds so a bad
        // input can't park a worker for 24 days or loop forever.
        const MAX_PAUSE_MS = 60_000; // 1 min — no legitimate use case for longer
        const MAX_STEP_DAYS = 365; // keep windows bounded
        const MAX_BATCH = 1_000;
        const stepDays = clampPositiveInt(options.stepDays, 1, MAX_STEP_DAYS);
        const pauseMs = clampNonNegativeInt(options.pauseMs, 5_000, MAX_PAUSE_MS);
        const batchSize = clampPositiveInt(options.batchSize, 200, MAX_BATCH);
        const until = options.until ? new Date(options.until) : new Date();

        const checkpoint = options.fresh
            ? null
            : await this.readCheckpoint();
        const explicitFrom = options.from ? new Date(options.from) : null;
        const oldest = await this.findOldestCreatedAt();

        let cursor =
            checkpoint?.cursorAt ??
            explicitFrom ??
            oldest ??
            new Date('2020-01-01T00:00:00Z');

        const startedAt = new Date();
        await this.upsertCheckpoint({
            cursorAt: cursor,
            status: 'running',
            startedAt,
            finishedAt: null,
            scannedTotal: Number(checkpoint?.scannedTotal ?? 0),
            lastError: null,
            params: {
                stepDays,
                pauseMs,
                batchSize,
                from: explicitFrom?.toISOString() ?? null,
                until: until.toISOString(),
                organizationId: options.organizationId ?? null,
            },
        });

        let scannedTotal = Number(checkpoint?.scannedTotal ?? 0);
        let upsertedTotal = 0;
        let windows = 0;
        let latestUpdatedAt: Date | null = null;
        let latestId: string | null = null;

        try {
            while (cursor < until) {
                if (options.signal?.aborted) {
                    this.logger.warn(
                        `backfill aborted at cursor=${cursor.toISOString()} ` +
                            `— windows=${windows} scanned=${scannedTotal}`,
                    );
                    const finishedAt = new Date();
                    await this.upsertCheckpoint({
                        cursorAt: cursor,
                        status: 'paused',
                        startedAt,
                        finishedAt,
                        scannedTotal,
                        lastError: null,
                        params: null,
                    });
                    return {
                        startedAt,
                        finishedAt,
                        windows,
                        scannedTotal,
                        upsertedTotal,
                        finalCursor: cursor,
                        status: 'paused',
                    };
                }
                const windowEnd = new Date(
                    Math.min(
                        cursor.getTime() + stepDays * 86_400_000,
                        until.getTime(),
                    ),
                );
                const winStart = Date.now();
                const res = await this.ingestion.run({
                    since: cursor,
                    until: windowEnd,
                    cursorField: 'createdAt',
                    batchSize,
                    organizationId: options.organizationId,
                    source: SOURCE,
                    mode: 'backfill',
                });
                scannedTotal += res.scanned;
                upsertedTotal += res.upsertedPRs;
                // Keep the tuple pair together: when a window observes
                // a newer `updatedAt`, replace both halves. When it
                // merely ties the current tuple's timestamp, only
                // advance the `_id` tiebreaker (matches the ingestion
                // service's own tuple semantics).
                if (res.newWatermark) {
                    if (
                        !latestUpdatedAt ||
                        res.newWatermark > latestUpdatedAt
                    ) {
                        latestUpdatedAt = res.newWatermark;
                        latestId = res.newWatermarkId ?? null;
                    } else if (
                        latestUpdatedAt &&
                        res.newWatermark.getTime() ===
                            latestUpdatedAt.getTime() &&
                        res.newWatermarkId
                    ) {
                        latestId = res.newWatermarkId;
                    }
                }
                windows += 1;

                cursor = windowEnd;
                await this.upsertCheckpoint({
                    cursorAt: cursor,
                    status: cursor >= until ? 'completed' : 'running',
                    startedAt,
                    finishedAt: cursor >= until ? new Date() : null,
                    scannedTotal,
                    lastError: null,
                    params: null,
                });

                this.logger.log(
                    `backfill window done: cursor=${cursor.toISOString()} ` +
                        `scanned=${res.scanned} prs=${res.upsertedPRs} ` +
                        `total_scanned=${scannedTotal} window_ms=${
                            Date.now() - winStart
                        }`,
                );

                if (cursor < until && pauseMs > 0) {
                    await this.sleepInterruptible(pauseMs, options.signal);
                }
            }

            // Seed the incremental watermark so the daily cron starts
            // tight against the last observed tuple. Without this, the
            // next cron tick sees a NULL watermark and rescans everything.
            if (latestUpdatedAt) {
                await this.seedIncrementalWatermark(
                    latestUpdatedAt,
                    latestId,
                );
            }

            const finishedAt = new Date();
            this.logger.log(
                `backfill completed: windows=${windows} scanned=${scannedTotal} ` +
                    `upserted=${upsertedTotal} duration_ms=${
                        finishedAt.getTime() - startedAt.getTime()
                    }`,
            );

            return {
                startedAt,
                finishedAt,
                windows,
                scannedTotal,
                upsertedTotal,
                finalCursor: cursor,
                status: 'completed',
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.upsertCheckpoint({
                cursorAt: cursor,
                status: 'failed',
                startedAt,
                finishedAt: null,
                scannedTotal,
                lastError: message,
                params: null,
            });
            this.logger.error(
                `backfill failed at cursor=${cursor.toISOString()}: ${message}`,
                err instanceof Error ? err.stack : undefined,
            );
            throw err;
        }
    }

    private async findOldestCreatedAt(): Promise<Date | null> {
        const doc = (await this.pullRequestsModel
            .findOne({}, { createdAt: 1, _id: 0 })
            .read('secondaryPreferred')
            .sort({ createdAt: 1 })
            .lean()
            .exec()) as { createdAt?: unknown } | null;
        const ts = doc?.createdAt;
        if (!ts) return null;
        if (ts instanceof Date) return ts;
        if (typeof ts === 'string' || typeof ts === 'number') {
            const d = new Date(ts);
            return isNaN(d.getTime()) ? null : d;
        }
        return null;
    }

    private async readCheckpoint(): Promise<{
        cursorAt: Date;
        status: string;
        scannedTotal: string;
    } | null> {
        const rows = (await this.analyticsDs.query(
            `SELECT "cursor_at", "status", "scanned_total"
             FROM "analytics"."backfill_progress" WHERE "source" = $1`,
            [SOURCE],
        )) as Array<{
            cursor_at: Date;
            status: string;
            scanned_total: string;
        }>;
        if (!rows.length) return null;
        return {
            cursorAt: rows[0].cursor_at,
            status: rows[0].status,
            scannedTotal: rows[0].scanned_total,
        };
    }

    private async upsertCheckpoint(input: {
        cursorAt: Date;
        status: string;
        startedAt: Date;
        finishedAt: Date | null;
        scannedTotal: number;
        lastError: string | null;
        params: Record<string, unknown> | null;
    }): Promise<void> {
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."backfill_progress" (
                "source", "cursor_at", "status", "started_at", "updated_at",
                "finished_at", "scanned_total", "last_error", "params"
             ) VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8::jsonb)
             ON CONFLICT ("source") DO UPDATE SET
                "cursor_at" = EXCLUDED."cursor_at",
                "status" = EXCLUDED."status",
                "updated_at" = now(),
                "finished_at" = COALESCE(
                    EXCLUDED."finished_at",
                    "analytics"."backfill_progress"."finished_at"
                ),
                "scanned_total" = EXCLUDED."scanned_total",
                "last_error" = EXCLUDED."last_error",
                "params" = COALESCE(
                    EXCLUDED."params",
                    "analytics"."backfill_progress"."params"
                )`,
            [
                SOURCE,
                input.cursorAt,
                input.status,
                input.startedAt,
                input.finishedAt,
                input.scannedTotal,
                input.lastError,
                input.params ? JSON.stringify(input.params) : null,
            ],
        );
    }

    private async seedIncrementalWatermark(
        at: Date,
        id: string | null,
    ): Promise<void> {
        // Idempotent and conservative: only seeds if the incoming tuple
        // `(at, id)` is strictly greater than whatever is already there.
        // Mirrors the CASE/COALESCE comparison in
        // PullRequestIngestionService.writeWatermark so both writers agree.
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."watermarks" (
                "table_name", "last_source_updated_at", "last_source_id",
                "last_run_at", "last_status", "last_error"
             ) VALUES ($1, $2, $3, now(), 'backfill_seed', NULL)
             ON CONFLICT ("table_name") DO UPDATE SET
                "last_source_updated_at" = CASE
                    WHEN (
                        EXCLUDED."last_source_updated_at",
                        COALESCE(EXCLUDED."last_source_id", '')
                    ) > (
                        COALESCE(
                            "analytics"."watermarks"."last_source_updated_at",
                            'epoch'::timestamptz
                        ),
                        COALESCE("analytics"."watermarks"."last_source_id", '')
                    )
                    THEN EXCLUDED."last_source_updated_at"
                    ELSE "analytics"."watermarks"."last_source_updated_at"
                END,
                "last_source_id" = CASE
                    WHEN (
                        EXCLUDED."last_source_updated_at",
                        COALESCE(EXCLUDED."last_source_id", '')
                    ) > (
                        COALESCE(
                            "analytics"."watermarks"."last_source_updated_at",
                            'epoch'::timestamptz
                        ),
                        COALESCE("analytics"."watermarks"."last_source_id", '')
                    )
                    THEN EXCLUDED."last_source_id"
                    ELSE "analytics"."watermarks"."last_source_id"
                END,
                "last_run_at" = now()`,
            [SOURCE, at, id],
        );
    }

    private sleepInterruptible(
        ms: number,
        signal?: AbortSignal,
    ): Promise<void> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve();
                return;
            }
            let timer: ReturnType<typeof setTimeout> | null = null;
            const onAbort = () => {
                if (timer) clearTimeout(timer);
                resolve();
            };
            timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}
