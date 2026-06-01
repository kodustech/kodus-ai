import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectDataSource } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { PullRequestsModel } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

import { ANALYTICS_DATA_SOURCE } from '../schema.constant';

import {
    classificationBatchSchema,
    prompt_ClassifyPRTypesSystem,
    prompt_ClassifyPRTypesUser,
    PRType,
    PR_TYPES,
} from './classification.prompts';

interface ClassifierRunOptions {
    /** Max PRs pulled from Postgres per run (across all orgs). */
    maxRows?: number;
    /** How many titles per LLM call. Bigger = fewer calls, more tokens. */
    batchSize?: number;
    /** Scope a run to one org (manual/debug). Default: all orgs. */
    organizationId?: string;
}

interface ClassifierRunResult {
    scanned: number;
    classified: number;
    failed: number;
    batches: number;
    durationMs: number;
}

interface PendingRow {
    id: string;
    organizationId: string;
    title?: string;
}

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_BATCH_SIZE = 25;

/**
 * Classifies pull requests 4-way (Bug Fix / Feature / Refactor / Test)
 * via LLM and writes the result to `analytics.pull_request_types`.
 *
 * Why a dedicated service and not inline with ingestion:
 *  - Ingestion is a tight loop (thousands of PRs/min during backfill).
 *    LLM latency would stall the hot path; quarantining retries would
 *    pollute `ingestion_errors` with recoverable LLM failures.
 *  - The classifier is best-effort enrichment. If it's down for a day
 *    the warehouse is still consistent; bug_ratio just reports zero
 *    until we catch up.
 *  - Easier to iterate on the prompt / model without touching the
 *    ingestion write path.
 *
 * Idempotency: rerun is cheap — the `LEFT JOIN pull_request_types` in
 * the pending query excludes PRs we've already classified. A retry
 * after a partial failure only reprocesses what didn't land.
 */
@Injectable()
export class PullRequestClassifierService {
    private readonly logger = new Logger(PullRequestClassifierService.name);

    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<PullRequestsModel>,
        private readonly promptRunnerService: PromptRunnerService,
    ) {}

    async run(options: ClassifierRunOptions = {}): Promise<ClassifierRunResult> {
        const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
        const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
        const startedAt = Date.now();

        const pendingIds = await this.fetchPending({
            limit: maxRows,
            organizationId: options.organizationId,
        });

        if (pendingIds.length === 0) {
            return {
                scanned: 0,
                classified: 0,
                failed: 0,
                batches: 0,
                durationMs: Date.now() - startedAt,
            };
        }

        // Titles don't live in `pull_requests_opt` (projection drops them
        // to keep scans cheap). Fetch them from the Mongo `pullRequests`
        // collection by the PR ids we just got from PG.
        const titlesById = await this.fetchTitlesFromMongo(pendingIds);

        const pending = pendingIds
            .map((row) => ({
                ...row,
                title: titlesById.get(row.id),
            }))
            .filter((row): row is Required<PendingRow> =>
                Boolean(row.title && row.title.trim()),
            );

        let classified = 0;
        let failed = pendingIds.length - pending.length;
        let batches = 0;

        for (let i = 0; i < pending.length; i += batchSize) {
            const batch = pending.slice(i, i + batchSize);
            batches += 1;
            try {
                const results = await this.classifyBatch(batch);
                const written = await this.writeClassifications(batch, results);
                classified += written;
                failed += batch.length - written;
            } catch (err) {
                failed += batch.length;
                this.logger.warn(
                    `classifier batch failed (size=${batch.length}): ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                // Don't rethrow — next cron tick retries the same rows
                // because they still lack a row in pull_request_types.
            }
        }

        return {
            scanned: pendingIds.length,
            classified,
            failed,
            batches,
            durationMs: Date.now() - startedAt,
        };
    }

    private async fetchPending(args: {
        limit: number;
        organizationId?: string;
    }): Promise<PendingRow[]> {
        const params: unknown[] = [args.limit];
        const orgFilter = args.organizationId
            ? (params.unshift(args.organizationId),
              `AND pr."organizationId" = $1`)
            : '';
        // Prioritize recent PRs so freshest data powers the dashboard
        // highlights users see first. Order by `parsed_created_at` —
        // matches the existing `idx_pr_opt_org_created` composite
        // index (default `ASC NULLS LAST`), which Postgres walks
        // backward for `DESC` queries. No explicit `NULLS LAST` here:
        // default `DESC NULLS FIRST` is what enables the reverse index
        // scan. Rows with `NULL parsed_created_at` (odd legacy data)
        // land first and get classified early — harmless.
        const limitPos = params.length;
        const rows = (await this.ds.query(
            `SELECT pr."_id"             AS id,
                    pr."organizationId"  AS "organizationId"
               FROM "analytics"."pull_requests_opt" pr
          LEFT JOIN "analytics"."pull_request_types" prt
                 ON prt."pullRequestId" = pr."_id"
              WHERE prt."pullRequestId" IS NULL
                ${orgFilter}
           ORDER BY pr.parsed_created_at DESC
              LIMIT $${limitPos}`,
            params,
        )) as PendingRow[];
        return rows;
    }

    private async fetchTitlesFromMongo(
        pending: PendingRow[],
    ): Promise<Map<string, string>> {
        if (!pending.length) return new Map();
        const ids = pending.map((row) => row.id);
        const docs = await this.pullRequestsModel
            .find(
                { _id: { $in: ids } as unknown as string[] },
                { _id: 1, title: 1 },
            )
            .lean<Array<{ _id: unknown; title?: string }>>()
            .exec();

        const out = new Map<string, string>();
        for (const doc of docs) {
            const id = String(doc._id);
            if (doc.title && doc.title.trim()) {
                out.set(id, doc.title);
            }
        }
        return out;
    }

    private async classifyBatch(
        batch: Required<PendingRow>[],
    ): Promise<Map<string, PRType>> {
        const payload = batch.map((row) => ({
            pullRequestId: row.id,
            title: row.title,
        }));

        const result = await this.promptRunnerService
            .builder()
            .setProviders({
                main: LLMModelProvider.GEMINI_3_1_FLASH_LITE_PREVIEW,
                fallback: LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
            })
            .setParser(ParserType.ZOD, classificationBatchSchema)
            .setLLMJsonMode(true)
            .addPrompt({
                role: PromptRole.SYSTEM,
                prompt: prompt_ClassifyPRTypesSystem,
            })
            .addPrompt({
                role: PromptRole.USER,
                prompt: prompt_ClassifyPRTypesUser(payload),
            })
            .setRunName('analytics.pr-type-classifier')
            .execute();

        const classifications = result?.classifications ?? [];
        const map = new Map<string, PRType>();
        for (const c of classifications) {
            // Defensive: the model sometimes echoes a `pullRequestId`
            // with trailing whitespace from the JSON input.
            const id = c.pullRequestId?.trim();
            if (id && PR_TYPES.includes(c.type)) {
                map.set(id, c.type);
            }
        }
        return map;
    }

    private async writeClassifications(
        batch: Required<PendingRow>[],
        results: Map<string, PRType>,
    ): Promise<number> {
        const rows = batch.filter((row) => results.has(row.id));
        if (rows.length === 0) return 0;

        // Single multi-values INSERT … ON CONFLICT keeps the write
        // cheap and atomic per batch. Conflict target = primary key.
        const values: string[] = [];
        const params: unknown[] = [];
        rows.forEach((row, i) => {
            const base = i * 3;
            values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            params.push(row.id, row.organizationId, results.get(row.id)!);
        });

        await this.ds.query(
            `INSERT INTO "analytics"."pull_request_types"
                 ("pullRequestId", "organizationId", "type")
             VALUES ${values.join(', ')}
             ON CONFLICT ("pullRequestId") DO UPDATE SET
                 "type" = EXCLUDED."type",
                 "organizationId" = EXCLUDED."organizationId"`,
            params,
        );
        return rows.length;
    }
}
