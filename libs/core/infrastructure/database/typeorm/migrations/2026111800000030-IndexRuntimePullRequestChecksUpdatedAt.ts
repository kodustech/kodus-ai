import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime check slots (`runtime_pr_checks`): one row per PR head and
 * check name, so the table grows with every push. The Runtime product
 * retention cron deletes a row untouched for 30 days, by this index on
 * updated_at. The table is new in this release and small: a plain index.
 */
export class IndexRuntimePullRequestChecksUpdatedAt2026111800000030 implements MigrationInterface {
    name = 'IndexRuntimePullRequestChecksUpdatedAt2026111800000030';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_runtime_pr_checks_updated_at" ON "runtime_pr_checks" ("updated_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_runtime_pr_checks_updated_at"`);
    }
}
