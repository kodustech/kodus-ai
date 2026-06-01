import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DataSource } from 'typeorm';

import { PullRequestsModel } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

import { ANALYTICS_DATA_SOURCE } from '../schema.constant';
import { parseTimestamp } from './parse-timestamps.util';

export const PR_INGESTION_WATERMARK = 'pull_requests';
export const PR_INGESTION_SOURCE = 'pull_requests';

export type IngestionMode = 'incremental' | 'backfill' | 'replay';
export type IngestionCursorField = 'updatedAt' | 'createdAt';

export interface IngestionRunOptions {
    /**
     * Legacy single-shot backfill: ignores watermark, scans every PR, and
     * advances the watermark to `max(updatedAt)` at the end. Kept for
     * small tenants (self-hosted) where chunking is overkill.
     */
    backfill?: boolean;
    /** Hard cap on rows per run (safety in backfill mode). */
    maxRows?: number;
    /** How many PRs to pull per Mongo fetch. Default 500. */
    batchSize?: number;
    /**
     * Explicit window. When set, the watermark is NOT consulted nor
     * advanced — the caller (e.g. chunked backfill CLI) owns watermark
     * lifecycle. Filter is `cursorField IN [since, until)`.
     */
    since?: Date;
    until?: Date;
    /** Defaults to `updatedAt`. Backfill chunks by `createdAt` so each PR
     * lands in exactly one window. */
    cursorField?: IngestionCursorField;
    /** Restrict to a single org (replay/spot-fix). */
    organizationId?: string;
    /** Label for `ingestion_runs.source`. Default `pull_requests`. */
    source?: string;
    /** Label for `ingestion_runs.mode`. Inferred when omitted. */
    mode?: IngestionMode;
}

export interface IngestionRunResult {
    scanned: number;
    upsertedPRs: number;
    insertedSuggestions: number;
    insertedCommits: number;
    quarantined: number;
    /** Max `updatedAt` observed in this run. */
    newWatermark: Date | null;
    /** `_id` of the doc that contributed `newWatermark` — persisted as
     * the second half of the tuple watermark so the next run resumes
     * past the same-timestamp tiebreaker safely. */
    newWatermarkId: string | null;
    runId: string | null;
    durationMs: number;
}

/**
 * One-shot ingestion pass: pulls PRs from Mongo (filtered by
 * `updatedAt > watermark`), explodes their nested `files[].suggestions[]`
 * and `commits[]` into the relational `analytics.*` tables, and advances
 * the watermark.
 *
 * Idempotent: re-running the same window UPSERTs identical rows. A crash
 * mid-run just replays from the last committed watermark.
 */
@Injectable()
export class PullRequestIngestionService {
    private readonly logger = new Logger(PullRequestIngestionService.name);
    // Counter used to give each quarantine SAVEPOINT a unique name within
    // its outer batch transaction. Mongo `_id` alone is not enough — same
    // PR can appear in errorBuffer twice (rare) if writeOnePR retries.
    private quarantineSeq = 0;

    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly analyticsDs: DataSource,
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<PullRequestsModel>,
    ) {}

    async run(options: IngestionRunOptions = {}): Promise<IngestionRunResult> {
        const batchSize = options.batchSize ?? 500;
        const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
        const cursorField: IngestionCursorField =
            options.cursorField ?? 'updatedAt';
        const source = options.source ?? PR_INGESTION_SOURCE;
        const explicitWindow =
            options.since !== undefined || options.until !== undefined;
        const mode: IngestionMode =
            options.mode ??
            (explicitWindow
                ? 'replay'
                : options.backfill
                  ? 'backfill'
                  : 'incremental');

        // Watermark is only consulted/advanced for the default incremental
        // path. Explicit windows (chunked backfill, replay) leave it alone
        // so the daily cursor is never corrupted by a side run.
        const useWatermark = !explicitWindow && !options.backfill;
        const advanceWatermark = !explicitWindow;
        const watermark = useWatermark ? await this.readWatermark() : null;

        const filter: Record<string, unknown> = {};
        if (options.organizationId) {
            // Defense against Mongo operator injection: a caller that
            // forwards raw user input (e.g. the admin HTTP endpoint)
            // could pass `{$ne: null}` as the org id and match every
            // tenant. Only accept plain strings.
            if (typeof options.organizationId !== 'string') {
                throw new Error(
                    'organizationId must be a string, not an object',
                );
            }
            filter.organizationId = options.organizationId;
        }
        if (options.since && !(options.since instanceof Date)) {
            throw new Error('since must be a Date instance');
        }
        if (options.until && !(options.until instanceof Date)) {
            throw new Error('until must be a Date instance');
        }
        if (useWatermark && watermark) {
            // Tuple filter: resume strictly after `(updatedAt, _id)`.
            // Handles same-timestamp ties that a scalar `>` would skip.
            // Falls back to scalar `>` when the stored id is missing
            // (fresh install or pre-tuple watermark).
            if (watermark.id) {
                const idCursor = this.toObjectIdOrString(watermark.id);
                filter.$or = [
                    { updatedAt: { $gt: watermark.updatedAt } },
                    {
                        updatedAt: watermark.updatedAt,
                        _id: { $gt: idCursor },
                    },
                ];
            } else {
                filter.updatedAt = { $gt: watermark.updatedAt };
            }
        }
        if (explicitWindow) {
            const range: Record<string, Date> = {};
            if (options.since) range.$gte = options.since;
            if (options.until) range.$lt = options.until;
            filter[cursorField] = range;
        }

        // Projection: only fields the warehouse actually needs. Keeps
        // payload small (PR docs can be MBs each — files[] + suggestions[]
        // dominate). Anything not listed never crosses the wire.
        const projection = {
            _id: 1,
            organizationId: 1,
            repository: 1,
            status: 1,
            user: 1,
            totalChanges: 1,
            createdAt: 1,
            openedAt: 1,
            closedAt: 1,
            updatedAt: 1,
            files: 1,
            commits: 1,
        } as const;

        // Tuple sort pairs the cursor field with `_id` so ties are
        // deterministic and the watermark resume is stable across runs.
        const sortKey: Record<string, 1> = { [cursorField]: 1, _id: 1 };

        // Read from a secondary node — this is a heavy scan-by-range that
        // has nothing to do with the OLTP write path of the review pipeline.
        // Atlas replication lag (sub-second typical) is harmless here:
        // the watermark just picks up whatever wasn't visible yet on the
        // next run.
        const cursor = this.pullRequestsModel
            .find(filter, projection)
            .read('secondaryPreferred')
            .sort(sortKey)
            .lean()
            .cursor({ batchSize });

        const startedAt = Date.now();
        const runId = await this.startRun({
            source,
            mode,
            since: options.since ?? null,
            until: options.until ?? null,
            organizationId: options.organizationId ?? null,
        });

        let scanned = 0;
        let upsertedPRs = 0;
        let insertedSuggestions = 0;
        let insertedCommits = 0;
        let quarantined = 0;
        let newestUpdatedAt: Date | null = useWatermark
            ? watermark?.updatedAt ?? null
            : null;
        let newestId: string | null = useWatermark
            ? watermark?.id ?? null
            : null;
        let mongoMs = 0;
        let writeMs = 0;
        let lastMongoTick = Date.now();

        const buffer: PullRequestsModel[] = [];
        const flush = async () => {
            if (!buffer.length) return;
            const writeStart = Date.now();
            const res = await this.writeBatch(buffer, runId, source);
            writeMs += Date.now() - writeStart;
            upsertedPRs += res.upsertedPRs;
            insertedSuggestions += res.insertedSuggestions;
            insertedCommits += res.insertedCommits;
            quarantined += res.quarantined;
            buffer.length = 0;
        };

        try {
            for await (const doc of cursor) {
                mongoMs += Date.now() - lastMongoTick;
                if (scanned >= maxRows) break;
                scanned += 1;
                buffer.push(doc as PullRequestsModel);

                const u = (doc as { updatedAt?: unknown }).updatedAt;
                const asDate = parseTimestamp(u);
                const docId = (doc as { _id?: unknown })._id;
                // Advance tuple when we see a strictly newer timestamp,
                // OR when the timestamp matches and the _id sorts after.
                // Since the cursor is sorted `(updatedAt, _id) ASC`, the
                // last doc seen in either case is the correct tiebreaker.
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

                if (buffer.length >= batchSize) {
                    await flush();
                }
                lastMongoTick = Date.now();
            }
            await flush();

            if (advanceWatermark) {
                if (scanned > 0 && newestUpdatedAt) {
                    await this.writeWatermark(
                        newestUpdatedAt,
                        newestId,
                        'ok',
                    );
                } else if (scanned === 0) {
                    await this.heartbeat();
                }
            }

            // A run is "partial" when quarantine fired — the warehouse
            // is still consistent (savepoints rolled back the bad PRs),
            // but ops should investigate. Threshold makes a single
            // schema-drift event visible without spamming alerts on
            // 1-in-a-million bad rows.
            const errorRatio =
                scanned > 0 ? quarantined / scanned : 0;
            const status: 'ok' | 'partial' =
                quarantined > 0 &&
                (quarantined >= 10 || errorRatio > 0.01)
                    ? 'partial'
                    : 'ok';

            const totalMs = Date.now() - startedAt;
            await this.completeRun(runId, {
                status,
                scanned,
                upsertedPRs,
                insertedSuggestions,
                insertedCommits,
                quarantined,
                mongoMs,
                writeMs,
                newWatermark: advanceWatermark ? newestUpdatedAt : null,
                error: null,
            });

            this.logger.log(
                `analytics ingestion done: source=${source} mode=${mode} ` +
                    `status=${status} scanned=${scanned} prs=${upsertedPRs} ` +
                    `suggestions=${insertedSuggestions} commits=${insertedCommits} ` +
                    `quarantined=${quarantined} ` +
                    `total_ms=${totalMs} mongo_ms=${mongoMs} write_ms=${writeMs} ` +
                    `watermark=${newestUpdatedAt?.toISOString() ?? 'null'}`,
            );

            return {
                scanned,
                upsertedPRs,
                insertedSuggestions,
                insertedCommits,
                quarantined,
                newWatermark: newestUpdatedAt,
                newWatermarkId: newestId,
                runId,
                durationMs: totalMs,
            };
        } catch (err) {
            await this.completeRun(runId, {
                status: 'failed',
                scanned,
                upsertedPRs,
                insertedSuggestions,
                insertedCommits,
                quarantined,
                mongoMs,
                writeMs,
                newWatermark: null,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }

    /**
     * Per-PR isolation via SAVEPOINTs: a single malformed PR (schema
     * drift, bad jsonb, etc.) rolls back only its own writes and lands
     * in `analytics.ingestion_errors`. The rest of the batch commits
     * normally — one bad row never stalls the daily cron.
     *
     * Trade-off: a SAVEPOINT per PR adds ~1 round-trip each, but they
     * all share one outer transaction so the COMMIT cost stays amortized.
     */
    private async writeBatch(
        prs: PullRequestsModel[],
        runId: string | null,
        source: string,
    ): Promise<{
        upsertedPRs: number;
        insertedSuggestions: number;
        insertedCommits: number;
        quarantined: number;
    }> {
        return this.analyticsDs.transaction(async (manager) => {
            let upsertedPRs = 0;
            let insertedSuggestions = 0;
            let insertedCommits = 0;
            let quarantined = 0;

            const errorBuffer: Array<{
                pr: PullRequestsModel;
                err: unknown;
            }> = [];

            for (let i = 0; i < prs.length; i += 1) {
                const pr = prs[i];
                const sp = `pr_${i}`;
                await manager.query(`SAVEPOINT "${sp}"`);
                try {
                    const r = await this.writeOnePR(manager, pr);
                    upsertedPRs += 1;
                    insertedSuggestions += r.suggestions;
                    insertedCommits += r.commits;
                    await manager.query(`RELEASE SAVEPOINT "${sp}"`);
                } catch (err) {
                    await manager.query(`ROLLBACK TO SAVEPOINT "${sp}"`);
                    quarantined += 1;
                    errorBuffer.push({ pr, err });
                }
            }

            // Quarantine inserts run inside the outer tx but AFTER the
            // savepoints — they survive the rollbacks of individual PRs.
            for (const { pr, err } of errorBuffer) {
                await this.recordQuarantine(manager, {
                    runId,
                    source,
                    pr,
                    err,
                });
            }

            return {
                upsertedPRs,
                insertedSuggestions,
                insertedCommits,
                quarantined,
            };
        });
    }

    private async writeOnePR(
        manager: import('typeorm').EntityManager,
        pr: PullRequestsModel,
    ): Promise<{ suggestions: number; commits: number }> {
        const prId = String((pr as unknown as { _id: unknown })._id);

        const parsedCreated = parseTimestamp(
            (pr as unknown as { createdAt?: unknown }).createdAt,
        );
        const parsedOpened = parseTimestamp(pr.openedAt);
        const parsedClosed = parseTimestamp(pr.closedAt);
        const sourceUpdatedAt = parseTimestamp(
            (pr as unknown as { updatedAt?: unknown }).updatedAt,
        );

        await manager.query(
            `INSERT INTO "analytics"."pull_requests_opt" (
                "_id", "organizationId", "repo_full_name", "repositoryId",
                "status", "authorId", "author_username", "totalChanges",
                "createdAt", "openedAt", "closedAt",
                "parsed_created_at", "parsed_opened_at", "parsed_closed_at",
                "files", "commits", "source_updated_at"
             )
             VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11,
                $12, $13, $14,
                $15::jsonb, $16::jsonb, $17
             )
             ON CONFLICT ("_id") DO UPDATE SET
                "organizationId" = EXCLUDED."organizationId",
                "repo_full_name" = EXCLUDED."repo_full_name",
                "repositoryId" = EXCLUDED."repositoryId",
                "status" = EXCLUDED."status",
                "authorId" = EXCLUDED."authorId",
                "author_username" = EXCLUDED."author_username",
                "totalChanges" = EXCLUDED."totalChanges",
                "createdAt" = EXCLUDED."createdAt",
                "openedAt" = EXCLUDED."openedAt",
                "closedAt" = EXCLUDED."closedAt",
                "parsed_created_at" = EXCLUDED."parsed_created_at",
                "parsed_opened_at" = EXCLUDED."parsed_opened_at",
                "parsed_closed_at" = EXCLUDED."parsed_closed_at",
                "files" = EXCLUDED."files",
                "commits" = EXCLUDED."commits",
                "source_updated_at" = EXCLUDED."source_updated_at",
                "ingested_at" = now()`,
            [
                prId,
                pr.organizationId,
                pr.repository?.fullName ?? null,
                pr.repository?.id ?? null,
                pr.status ?? null,
                pr.user?.id ?? null,
                pr.user?.username ?? null,
                pr.totalChanges ?? null,
                (pr as unknown as { createdAt?: string }).createdAt ?? null,
                pr.openedAt ?? null,
                pr.closedAt ?? null,
                parsedCreated,
                parsedOpened,
                parsedClosed,
                JSON.stringify(pr.files ?? []),
                JSON.stringify(pr.commits ?? []),
                sourceUpdatedAt,
            ],
        );

        // Wipe + re-insert children keeps semantics simple: a PR that
        // loses a suggestion/commit drops it from the warehouse.
        await manager.query(
            'DELETE FROM "analytics"."suggestions_mv" WHERE "pullRequestId" = $1',
            [prId],
        );
        await manager.query(
            'DELETE FROM "analytics"."commits_view" WHERE "pull_request_id" = $1',
            [prId],
        );

        let suggestions = 0;
        for (const file of pr.files ?? []) {
            for (const s of file.suggestions ?? []) {
                // `id` is only populated once a suggestion is actually
                // delivered (posted as a PR comment). Drafts that never
                // leave Kody (`deliveryStatus !== 'sent'`) are id-less
                // and every cockpit query filters by `sent` anyway, so
                // dropping them at ingestion is lossless. Skipping here
                // instead of letting the NOT NULL constraint fire saves
                // the surrounding PR from SAVEPOINT rollback that would
                // quarantine its `sent` siblings too.
                if (!s.id) {
                    continue;
                }
                const implStatus =
                    typeof s.implementationStatus === 'string'
                        ? s.implementationStatus
                        : (s.implementationStatus as unknown as {
                              default?: string;
                          })?.default ?? null;
                const createdAt = parseTimestamp(s.createdAt);
                await manager.query(
                    `INSERT INTO "analytics"."suggestions_mv" (
                        "suggestion_id", "organizationId", "pullRequestId",
                        "repositoryId", "filePath", "label", "severity",
                        "suggestionDeliveryStatus", "suggestionImplementationStatus",
                        "suggestionCreatedAt", "raw"
                     ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
                     )
                     ON CONFLICT ("suggestion_id") DO UPDATE SET
                        "suggestionDeliveryStatus" = EXCLUDED."suggestionDeliveryStatus",
                        "suggestionImplementationStatus" = EXCLUDED."suggestionImplementationStatus",
                        "suggestionCreatedAt" = EXCLUDED."suggestionCreatedAt",
                        "raw" = EXCLUDED."raw"`,
                    [
                        s.id,
                        pr.organizationId,
                        prId,
                        pr.repository?.id ?? null,
                        file.path ?? file.filename ?? null,
                        s.label ?? null,
                        s.severity ?? null,
                        s.deliveryStatus ?? null,
                        implStatus,
                        createdAt,
                        JSON.stringify(s),
                    ],
                );
                suggestions += 1;
            }
        }

        let commits = 0;
        for (const c of pr.commits ?? []) {
            const raw = c as unknown as {
                sha?: string;
                hash?: string;
                commit_hash?: string;
                commit_timestamp?: unknown;
                createdAt?: unknown;
                // GitHub/GitLab webhook payloads use snake_case and
                // frequently only populate `author.date` — the field we
                // relied on (`commit_timestamp` / `createdAt`) is rarely
                // present for real PRs.
                created_at?: unknown;
                author?: {
                    username?: string;
                    name?: string;
                    date?: unknown;
                };
            };
            const hash = raw.sha ?? raw.hash ?? raw.commit_hash;
            if (!hash) continue;
            const ts = parseTimestamp(
                raw.commit_timestamp ??
                    raw.createdAt ??
                    raw.created_at ??
                    raw.author?.date,
            );
            const tsRaw =
                typeof raw.commit_timestamp === 'string'
                    ? raw.commit_timestamp
                    : typeof raw.created_at === 'string'
                      ? raw.created_at
                      : typeof raw.author?.date === 'string'
                        ? raw.author.date
                        : null;
            await manager.query(
                `INSERT INTO "analytics"."commits_view" (
                    "pull_request_id", "commit_hash", "organizationId",
                    "commit_timestamp", "commit_timestamp_raw",
                    "author_username", "raw"
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7::jsonb
                 )
                 ON CONFLICT ("pull_request_id", "commit_hash") DO UPDATE SET
                    "commit_timestamp" = EXCLUDED."commit_timestamp",
                    "commit_timestamp_raw" = EXCLUDED."commit_timestamp_raw",
                    "author_username" = EXCLUDED."author_username",
                    "raw" = EXCLUDED."raw"`,
                [
                    prId,
                    hash,
                    pr.organizationId,
                    ts,
                    tsRaw,
                    raw.author?.username ?? raw.author?.name ?? null,
                    JSON.stringify(c),
                ],
            );
            commits += 1;
        }

        return { suggestions, commits };
    }

    private async recordQuarantine(
        manager: import('typeorm').EntityManager,
        input: {
            runId: string | null;
            source: string;
            pr: PullRequestsModel;
            err: unknown;
        },
    ): Promise<void> {
        const prId = (() => {
            try {
                return String(
                    (input.pr as unknown as { _id?: unknown })._id ?? null,
                );
            } catch {
                return null;
            }
        })();

        // Postgres `text` and `jsonb` both reject U+0000 (null byte). PR
        // payloads occasionally contain them — strip before INSERT so this
        // row can land. Without sanitisation the INSERT errored and the
        // outer batch transaction was poisoned: every PR upserted earlier
        // in the same batch silently ROLLBACK'd at COMMIT. That was the
        // root cause of ~33k PRs missing from the first prod backfill
        // (April 2026).
        const stripNulls = (s: string): string =>
            s.replace(/\u0000/g, '');
        const message = stripNulls(
            input.err instanceof Error
                ? input.err.message
                : String(input.err),
        );
        let rawJson: string;
        try {
            rawJson = stripNulls(JSON.stringify(input.pr));
        } catch {
            rawJson = '{}';
        }

        // Defense in depth: even after sanitisation, wrap the INSERT in a
        // SAVEPOINT so any unforeseen failure (constraint violation, schema
        // drift, future jsonb edge case) only rolls back this one quarantine
        // record — not the whole batch's prior PR upserts. Savepoint name
        // uses the PR id (Mongo ObjectId hex, always alphanumeric) plus a
        // monotonic seq to stay unique inside the outer transaction.
        const seq = ++this.quarantineSeq;
        const idPart = (prId ?? 'null').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
        const sp = `qrec_${idPart}_${seq}`;
        try {
            await manager.query(`SAVEPOINT "${sp}"`);
            await manager.query(
                `INSERT INTO "analytics"."ingestion_errors" (
                    "source", "pull_request_id", "organizationId", "run_id",
                    "reason", "error", "raw"
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
                [
                    input.source,
                    prId,
                    input.pr?.organizationId ?? null,
                    input.runId,
                    'write_failed',
                    message,
                    rawJson,
                ],
            );
            await manager.query(`RELEASE SAVEPOINT "${sp}"`);
        } catch (recordErr) {
            try {
                await manager.query(`ROLLBACK TO SAVEPOINT "${sp}"`);
            } catch {
                // Savepoint may not have been established yet; best-effort.
            }
            this.logger.warn(
                `failed to record ingestion_error for pr=${prId}: ${
                    recordErr instanceof Error
                        ? recordErr.message
                        : String(recordErr)
                }`,
            );
        }
    }

    /**
     * Reads the tuple watermark. Returns `null` when no row exists (first
     * run). Returns `{ updatedAt, id: null }` for legacy rows written
     * before the tuple migration — callers handle that by falling back
     * to scalar `$gt` semantics.
     */
    async readWatermark(): Promise<{
        updatedAt: Date;
        id: string | null;
    } | null> {
        const rows = (await this.analyticsDs.query(
            `SELECT "last_source_updated_at", "last_source_id"
             FROM "analytics"."watermarks" WHERE "table_name" = $1`,
            [PR_INGESTION_WATERMARK],
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

    private async writeWatermark(
        at: Date,
        id: string | null,
        status: string,
    ): Promise<void> {
        // Only overwrite the tuple if the new pair is strictly greater.
        // Postgres row arithmetic on `(timestamptz, text)` orders
        // naturally: compare `updatedAt` first, then `id` as tiebreaker.
        // `COALESCE` makes sure a NULL existing tuple is treated as the
        // smallest possible value so the first real tuple always wins.
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."watermarks" (
                "table_name", "last_source_updated_at", "last_source_id",
                "last_run_at", "last_status", "last_error"
             ) VALUES ($1, $2, $3, now(), $4, NULL)
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
                "last_run_at" = now(),
                "last_status" = EXCLUDED."last_status",
                "last_error" = NULL`,
            [PR_INGESTION_WATERMARK, at, id, status],
        );
    }

    private async heartbeat(): Promise<void> {
        await this.analyticsDs.query(
            `INSERT INTO "analytics"."watermarks" (
                "table_name", "last_source_updated_at", "last_source_id",
                "last_run_at", "last_status", "last_error"
             ) VALUES ($1, NULL, NULL, now(), 'idle', NULL)
             ON CONFLICT ("table_name") DO UPDATE SET
                "last_run_at" = now(),
                "last_status" = 'idle',
                "last_error" = NULL`,
            [PR_INGESTION_WATERMARK],
        );
    }

    /**
     * Tries to hand Mongo a proper ObjectId so the `_id` comparison
     * uses BSON ordering (fast, indexed). Falls back to the raw string
     * if the stored watermark isn't a valid ObjectId — happens if the
     * collection uses string `_id`s, or if a migration wrote something
     * else. Mongo accepts both shapes in `$gt`.
     */
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

    private async startRun(input: {
        source: string;
        mode: IngestionMode;
        since: Date | null;
        until: Date | null;
        organizationId: string | null;
    }): Promise<string | null> {
        try {
            const rows = (await this.analyticsDs.query(
                `INSERT INTO "analytics"."ingestion_runs" (
                    "source", "mode", "status", "since", "until", "organizationId"
                 ) VALUES ($1, $2, 'running', $3, $4, $5)
                 RETURNING "id"`,
                [
                    input.source,
                    input.mode,
                    input.since,
                    input.until,
                    input.organizationId,
                ],
            )) as Array<{ id: string | number }>;
            return rows[0]?.id != null ? String(rows[0].id) : null;
        } catch (err) {
            // Auxiliary table — never block the actual ingestion if it
            // can't write here (e.g. table missing in old self-hosted
            // before the migration runs).
            this.logger.warn(
                `failed to record ingestion_run start: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }
    }

    /**
     * Persist the outcome of a run. `runId === null` means startRun
     * couldn't write — we silently skip rather than crash the cron.
     */
    private async completeRun(
        runId: string | null,
        outcome: {
            status: 'ok' | 'partial' | 'failed';
            scanned: number;
            upsertedPRs: number;
            insertedSuggestions: number;
            insertedCommits: number;
            quarantined: number;
            mongoMs: number;
            writeMs: number;
            newWatermark: Date | null;
            error: string | null;
        },
    ): Promise<void> {
        if (!runId) return;
        try {
            await this.analyticsDs.query(
                `UPDATE "analytics"."ingestion_runs" SET
                    "finished_at" = now(),
                    "status" = $2,
                    "scanned" = $3,
                    "prs_upserted" = $4,
                    "suggestions_inserted" = $5,
                    "commits_inserted" = $6,
                    "errors_quarantined" = $7,
                    "mongo_ms" = $8,
                    "write_ms" = $9,
                    "new_watermark" = $10,
                    "error" = $11
                 WHERE "id" = $1`,
                [
                    runId,
                    outcome.status,
                    outcome.scanned,
                    outcome.upsertedPRs,
                    outcome.insertedSuggestions,
                    outcome.insertedCommits,
                    outcome.quarantined,
                    outcome.mongoMs,
                    outcome.writeMs,
                    outcome.newWatermark,
                    outcome.error,
                ],
            );
        } catch (err) {
            this.logger.warn(
                `failed to record ingestion_run completion: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}
