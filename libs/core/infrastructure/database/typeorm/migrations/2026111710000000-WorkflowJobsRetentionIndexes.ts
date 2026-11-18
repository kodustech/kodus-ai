import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #2582: the webhook failure monitor timed out on ~85% of its runs, and
 * workflow_jobs (13.6M rows, never cleaned) needs a retention job.
 *
 *   1. `idx_workflow_jobs_updated_at` ("updatedAt", "uuid") INCLUDE
 *      (workflowType, status) replaces `idx_workflow_jobs_webhook_monitor`. The old partial
 *      index led with "workflowType", the column its own WHERE already pins,
 *      so Postgres dropped that qual and walked the whole index (prod: 117k
 *      buffers / 35s for 3,461 rows). Leading with "updatedAt" bounds the scan
 *      to the 30-minute window, and the same index serves the retention
 *      cron's oldest-first walk; "uuid" makes its cursor exact when one
 *      UPDATE gave many rows the same updatedAt. Measured on PG 16 with 3M rows: 8,127
 *      buffers / 189ms -> 5 buffers / 0.1ms.
 *
 *   2. `job_id` indexes on inbox_messages and outbox_messages. Both FKs to
 *      workflow_jobs are ON DELETE NO ACTION, so every deleted job checks
 *      them; without an index each check is a sequential scan. Measured:
 *      2,000 deletes 9.2s -> 73ms.
 *
 *   3. A 2% autovacuum/analyze scale factor for workflow_jobs. The default
 *      10% let ~1.4M dead rows pile up before a vacuum; a fixed small
 *      threshold would keep vacuum and analyze running back to back while
 *      the retention cron drains the backlog. The TOAST relation gets the
 *      same: it holds 117 of the table's 120 GB in prod, and a table-level
 *      setting does not reach it.
 *
 * Every index statement is CONCURRENTLY and idempotent, with the same
 * self-heal for interrupted builds as CronPoolReliefIndexes2026080600000000.
 */
export class WorkflowJobsRetentionIndexes2026111710000000 implements MigrationInterface {
    name = 'WorkflowJobsRetentionIndexes2026111710000000';

    // CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Same precautions as PullRequestListIndexes: a statement_timeout that
        // kills a CONCURRENTLY build leaves an INVALID index, and an unbounded
        // lock wait (the ALTER TABLE below queues behind an anti-wraparound
        // autovacuum, which does not yield) would hang container boot.
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        await this.dropIfInvalid(queryRunner, 'IDX_inbox_messages_job_id');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_inbox_messages_job_id"
                ON "kodus_workflow"."inbox_messages" ("job_id")
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_outbox_messages_job_id');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_outbox_messages_job_id"
                ON "kodus_workflow"."outbox_messages" ("job_id")
        `);

        await this.dropIfInvalid(queryRunner, 'idx_workflow_jobs_updated_at');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_workflow_jobs_updated_at"
                ON "kodus_workflow"."workflow_jobs" ("updatedAt", "uuid")
                INCLUDE ("workflowType", "status")
        `);

        // Only once the replacement exists and is valid.
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."idx_workflow_jobs_webhook_monitor"`,
        );

        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs" SET (
                autovacuum_vacuum_scale_factor = 0.02,
                autovacuum_analyze_scale_factor = 0.02,
                toast.autovacuum_vacuum_scale_factor = 0.02
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs" RESET (
                autovacuum_vacuum_scale_factor,
                autovacuum_analyze_scale_factor,
                toast.autovacuum_vacuum_scale_factor
            )
        `);

        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_workflow_jobs_webhook_monitor"
                ON "kodus_workflow"."workflow_jobs" ("workflowType", "updatedAt" DESC, "status")
                WHERE "workflowType" = 'WEBHOOK_PROCESSING'
        `);
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."idx_workflow_jobs_updated_at"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."IDX_outbox_messages_job_id"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."IDX_inbox_messages_job_id"`,
        );
    }

    /** Drops an index only if a killed CONCURRENTLY build left it invalid. */
    private async dropIfInvalid(
        queryRunner: QueryRunner,
        indexName: string,
    ): Promise<void> {
        const invalid = (await queryRunner.query(
            `SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = $1
                AND n.nspname = 'kodus_workflow'
                AND NOT i.indisvalid`,
            [indexName],
        )) as unknown[];
        if (invalid.length) {
            await queryRunner.query(
                `DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."${indexName}"`,
            );
        }
    }
}
