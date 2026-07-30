import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Source-side indexes for analytics.review_operational_executions ingestion.
 * Cockpit still reads only the analytics schema; these indexes keep the
 * analytics worker's historical/import cursor from repeatedly scanning OLTP.
 */
export class ReviewOperationalIngestionIndexes2026061111000000
    implements MigrationInterface
{
    name = 'ReviewOperationalIngestionIndexes2026061111000000';

    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        // `CREATE INDEX CONCURRENTLY` on a large `automation_execution` can run
        // for many minutes. A global statement_timeout would abort it midway
        // and leave an INVALID index that `IF NOT EXISTS` then silently skips
        // forever. Disable the statement timeout for this session and keep a
        // bounded lock_timeout so we never wedge on the brief locks CONCURRENTLY
        // takes. (This runs in the dedicated, short-lived migration process, so
        // the session-level SET does not leak into the app's connection pool.)
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        // Self-heal: if a prior interrupted run left an invalid build behind,
        // drop it first so the CREATE below actually rebuilds it.
        await this.dropIfInvalid(
            queryRunner,
            'IDX_automation_exec_review_ops_watermark',
        );
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_automation_exec_review_ops_watermark"
                ON "automation_execution" ("updatedAt", "uuid")
                WHERE "pullRequestNumber" IS NOT NULL
                  AND "repositoryId" IS NOT NULL
                  AND "status" IN ('success', 'error', 'partial_error', 'skipped')
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_repositories_external_id');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_repositories_external_id"
                ON "repositories" ("external_id")
        `);
    }

    /**
     * Drops an index only if Postgres marked it invalid (a CONCURRENTLY build
     * that was killed mid-flight). Issued as a top-level statement because
     * `DROP INDEX CONCURRENTLY` cannot run inside a transaction/DO block.
     */
    private async dropIfInvalid(
        queryRunner: QueryRunner,
        indexName: string,
    ): Promise<void> {
        const invalid = (await queryRunner.query(
            `SELECT 1
               FROM pg_class c
               JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = $1
                AND NOT i.indisvalid`,
            [indexName],
        )) as unknown[];
        if (invalid.length) {
            await queryRunner.query(
                `DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "IDX_repositories_external_id"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "IDX_automation_exec_review_ops_watermark"
        `);
    }
}
