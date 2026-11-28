import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime lost-webhook reconciler (docs/runtime/webhook-reconciler.md):
 * the pull request heads the reconciler handed to the PR trigger, one row per
 * head, so a head is handed once across replicas and restarts. Product
 * Postgres, written only by the product worker; rows older than 30 days are
 * swept by the Runtime product retention cron.
 */
export class CreateRuntimeReconciledHeads2026111500000000 implements MigrationInterface {
    name = 'CreateRuntimeReconciledHeads2026111500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_reconciled_heads" (
                "organization_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "pr_number" integer NOT NULL,
                "head_sha" character varying(64) NOT NULL,
                "state" character varying(16) NOT NULL,
                "attempts" integer NOT NULL,
                "outcome" character varying(64),
                "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_reconciled_heads" PRIMARY KEY ("organization_id", "repository_id", "pr_number", "head_sha"),
                CONSTRAINT "CHK_runtime_reconciled_heads_state" CHECK ("state" IN ('claimed', 'decided', 'failed')),
                CONSTRAINT "CHK_runtime_reconciled_heads_attempts" CHECK ("attempts" >= 1)
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_runtime_reconciled_heads_updated_at" ON "runtime_reconciled_heads" ("updated_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_reconciled_heads"`);
    }
}
