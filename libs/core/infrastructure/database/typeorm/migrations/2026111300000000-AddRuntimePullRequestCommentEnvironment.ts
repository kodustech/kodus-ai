import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: one PR comment per environment the PR runs in (2026-11-13,
 * two environments overwrote each other's comment on one PR). The slot of
 * `runtime_pr_comments` is keyed by the environment too: '' (every existing
 * row) for the environment the repository is the primary of, so the
 * comments already on PRs keep being edited in place. Idempotent: the
 * column is added once, and the primary key is rebuilt only while it does
 * not hold the new column.
 */
export class AddRuntimePullRequestCommentEnvironment2026111300000000 implements MigrationInterface {
    name = 'AddRuntimePullRequestCommentEnvironment2026111300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_pr_comments" ADD COLUMN IF NOT EXISTS "environment_key" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_index i
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                    WHERE i.indrelid = to_regclass('runtime_pr_comments') AND i.indisprimary AND a.attname = 'environment_key'
                ) THEN
                    ALTER TABLE "runtime_pr_comments" DROP CONSTRAINT IF EXISTS "PK_runtime_pr_comments";
                    ALTER TABLE "runtime_pr_comments"
                        ADD CONSTRAINT "PK_runtime_pr_comments" PRIMARY KEY ("organization_id", "repository_id", "pr_number", "environment_key");
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Another environment's slot has no place in a key of one row per PR: its comment stays on the PR, unedited.
        await queryRunner.query(`DELETE FROM "runtime_pr_comments" WHERE "environment_key" <> ''`);
        await queryRunner.query(`ALTER TABLE "runtime_pr_comments" DROP CONSTRAINT IF EXISTS "PK_runtime_pr_comments"`);
        await queryRunner.query(
            `ALTER TABLE "runtime_pr_comments" ADD CONSTRAINT "PK_runtime_pr_comments" PRIMARY KEY ("organization_id", "repository_id", "pr_number")`,
        );
        await queryRunner.query(`ALTER TABLE "runtime_pr_comments" DROP COLUMN IF EXISTS "environment_key"`);
    }
}
