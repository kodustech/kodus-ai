import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes born from the 2026-08-06 cron pool-exhaustion incident.
 *
 * Every ALTER runs CONCURRENTLY (no ACCESS EXCLUSIVE) and is idempotent
 * via `IF NOT EXISTS`, so re-runs on a partially-applied cluster are
 * safe. See `dropIfInvalid()` below for the self-heal on interrupted
 * builds — same pattern used in ReviewOperationalIngestionIndexes.
 *
 * Coverage:
 *
 *   1. `workflow_jobs` — the WebhookFailureMonitorService cron ran a
 *      `COUNT(*) FILTER (status=...) FROM workflow_jobs WHERE
 *      workflowType='WEBHOOK_PROCESSING' AND updatedAt >= ...` every
 *      5min. Existing `(workflowType, updatedAt)` index forced a
 *      Bitmap Heap Scan re-checking `status` per row (3-16s in prod).
 *      Partial covering index turns it into an Index Only Scan
 *      (validated: 3.07s → 0.22s, 14× faster).
 *
 *   2. `session_events` — `type='session_end'` NOT EXISTS anti-join
 *      from ClassifyOrphanedSessionsCronProvider ran 2.5s avg / 5s
 *      max because the existing `(session_id, type)` btree still
 *      needed a heap fetch per matching row. Partial on `session_end`
 *      alone makes the NOT EXISTS a pure index probe.
 *
 *   3. `context_references` — the table had ZERO indexes despite
 *      2.5M queries/day. Every `find({ entityType, entityId })` /
 *      `find({ parentReferenceId })` was Seq Scan on a table that
 *      only grows. Two composite indexes cover the actual filter
 *      patterns in ContextReferenceRepository.applyFilter().
 */
export class CronPoolReliefIndexes2026080600000000 implements MigrationInterface {
    name = 'CronPoolReliefIndexes2026080600000000';

    // CREATE INDEX CONCURRENTLY forbids running inside a transaction.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ─────────────────────────────────────────────────────────────
        // 1. workflow_jobs — webhook failure monitor cron (5min tick)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(
            queryRunner,
            'idx_workflow_jobs_webhook_monitor',
            'kodus_workflow',
        );
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_workflow_jobs_webhook_monitor"
                ON "kodus_workflow"."workflow_jobs" ("workflowType", "updatedAt" DESC, "status")
                WHERE "workflowType" = 'WEBHOOK_PROCESSING'
        `);

        // ─────────────────────────────────────────────────────────────
        // 2. session_events — NOT EXISTS session_end (orphaned classifier)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_session_events_end_only');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_session_events_end_only"
                ON "session_events" ("session_id", "organization_id")
                WHERE "type" = 'session_end'
        `);

        // ─────────────────────────────────────────────────────────────
        // 3. context_references — ContextReferenceRepository.applyFilter
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_context_references_entity');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_context_references_entity"
                ON "context_references" ("entityType", "entityId")
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_context_references_parent');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_context_references_parent"
                ON "context_references" ("parentReferenceId")
                WHERE "parentReferenceId" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // DROP INDEX CONCURRENTLY also forbids transactions and cannot
        // run inside a DO block.
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."idx_workflow_jobs_webhook_monitor"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_session_events_end_only"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_context_references_entity"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_context_references_parent"`,
        );
    }

    /**
     * Drops an index only if Postgres flagged it invalid (a killed
     * CONCURRENTLY build). Must run as a top-level statement — DROP
     * INDEX CONCURRENTLY cannot execute inside a transaction/DO block.
     *
     * Schema-qualified on both halves, unlike the copy in
     * ReviewOperationalIngestionIndexes. That one gets away with it
     * because every index it touches lives in `public`; here the
     * workflow_jobs index lives in `kodus_workflow`, and an unqualified
     * DROP resolves against search_path instead — so the lookup would
     * find the invalid index (relname matches in any schema) and the
     * DROP would then silently no-op, leaving the self-heal broken for
     * exactly the index that needs it most.
     */
    private async dropIfInvalid(
        queryRunner: QueryRunner,
        indexName: string,
        schema = 'public',
    ): Promise<void> {
        const invalid = (await queryRunner.query(
            `SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = $1
                AND n.nspname = $2
                AND NOT i.indisvalid`,
            [indexName, schema],
        )) as unknown[];
        if (invalid.length) {
            await queryRunner.query(
                `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${indexName}"`,
            );
        }
    }
}
