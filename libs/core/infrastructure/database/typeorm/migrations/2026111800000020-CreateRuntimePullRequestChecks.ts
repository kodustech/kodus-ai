import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime check ordering (v-product V-02): the order of the last Runtime
 * check published on a PR head, per check name, and the short lease a
 * delivery holds while it writes the check, so a late fallback or redrive of
 * an older Run never moves the check a newer Run on the same head closed.
 * A new, empty table: nothing to backfill, no lock on an existing one.
 */
export class CreateRuntimePullRequestChecks2026111800000020 implements MigrationInterface {
    name = 'CreateRuntimePullRequestChecks2026111800000020';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_pr_checks" (
                "organization_id" text NOT NULL,
                "repository_id" text NOT NULL,
                "head_sha" text NOT NULL,
                "check_name" text NOT NULL,
                -- The Run's request time in ms x 10 plus the phase (checkOrderOf): past int4.
                "check_order" bigint,
                "lease_owner" text,
                "lease_until" TIMESTAMP WITH TIME ZONE,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_pr_checks" PRIMARY KEY ("organization_id", "repository_id", "head_sha", "check_name")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_pr_checks"`);
    }
}
