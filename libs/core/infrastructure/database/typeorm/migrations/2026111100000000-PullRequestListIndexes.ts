import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the Reviews screen (GET /pull-requests/executions and its
 * counters), which until now had nothing that led with the team.
 *
 * - `IDX_automation_exec_team_created_uuid` is the list: a team's executions
 *   already in `(createdAt DESC, uuid DESC)` order, so a page reads a page.
 *   Without it the planner walked the global `createdAt` index and discarded
 *   every other team's rows, or read the team's whole history and sorted it.
 *
 * - `IDX_automation_exec_team_pr_cover` is the counters: every column the
 *   "group executions by pull request" queries read, so they are answered
 *   from the index instead of fetching each execution's row (the rows carry
 *   the `dataExecution` jsonb and are what made those scans slow).
 *
 * Both rely on the queries filtering `team_automation_id` directly — see
 * AutomationExecutionRepository.findPullRequestTeamAutomationIds.
 */
export class PullRequestListIndexes2026111100000000 implements MigrationInterface {
    name = 'PullRequestListIndexes2026111100000000';

    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Same precautions as ReviewOperationalIngestionIndexes: CONCURRENTLY
        // on a large `automation_execution` can run for many minutes, and a
        // statement_timeout that kills it leaves an INVALID index behind that
        // `IF NOT EXISTS` would then skip forever.
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        await this.dropIfInvalid(
            queryRunner,
            'IDX_automation_exec_team_created_uuid',
        );
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_automation_exec_team_created_uuid"
                ON "automation_execution" ("team_automation_id", "createdAt" DESC, "uuid" DESC)
        `);

        await this.dropIfInvalid(
            queryRunner,
            'IDX_automation_exec_team_pr_cover',
        );
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_automation_exec_team_pr_cover"
                ON "automation_execution" ("team_automation_id", "repositoryId", "pullRequestNumber")
                INCLUDE ("status", "uuid")
                WHERE "pullRequestNumber" IS NOT NULL
                  AND "repositoryId" IS NOT NULL
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
            DROP INDEX CONCURRENTLY IF EXISTS "IDX_automation_exec_team_pr_cover"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "IDX_automation_exec_team_created_uuid"
        `);
    }
}
