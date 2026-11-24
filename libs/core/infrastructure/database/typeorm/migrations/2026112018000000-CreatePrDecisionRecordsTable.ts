import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-PR reconciler source-of-truth table. Created by the AGPL-only
 * `pr-decision-orchestrator` change. Bumps `pr_decision_records` with its
 * indexes, unique constraint, and JSONB columns.
 *
 * Notes for the on-call reviewer:
 *   - `gate_verdicts_snapshot` and `last_apply_outcome` are JSONB-free
 *     columns; their schema lives alongside reducer types in
 *     `libs/code-review/infrastructure/adapters/repositories/schemas/prDecisionRecord.model.ts`.
 *   - The unique constraint `pr_decision_records_repo_pr_head` is the
 *     reconciler's idempotency anchor: triggers for a stale head_sha
 *     cannot create duplicate rows.
 *   - `last_reconciled_at` is indexed so a debounced cron poll can sweep
 *     stale rows cheaply.
 */
export class CreatePrDecisionRecordsTable1717218600000
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "pr_decision_records" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                -- The CoreModel base declares these two without an explicit
                -- column name, so TypeORM expects them camelCased -- the
                -- convention every Postgres table in this codebase follows.
                -- Snake_case here made the model fail at RUNTIME with
                -- "column PrDecisionRecordModel.createdAt does not exist",
                -- which reads like a database problem rather than a schema
                -- mismatch.
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" uuid NOT NULL,
                -- The provider's repository id (Gitea's numeric id, GitHub's
                -- node id), not a Kodus uuid: the pipeline's Repository.id
                -- is the provider's id, and the other Postgres tables that
                -- key a repository store it as varchar.
                "repository_id" varchar NOT NULL,
                "pr_number" integer NOT NULL,
                "head_sha" text NOT NULL,
                "base_sha" text NOT NULL,
                "configuration_key" text NOT NULL,
                "gate_verdicts_snapshot" jsonb NOT NULL,
                "last_apply_outcome" jsonb NOT NULL,
                "last_reconciled_at" TIMESTAMP NOT NULL,
                "consecutive_failures" integer NOT NULL DEFAULT 0,
                "in_flight_trigger_kind" text,
                CONSTRAINT "pk_pr_decision_records" PRIMARY KEY ("uuid")
            )
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pr_decision_records_repo_pr_head"
                ON "pr_decision_records" ("repository_id", "pr_number", "head_sha")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IX_pr_decision_records_org_repo"
                ON "pr_decision_records" ("organization_id", "repository_id")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IX_pr_decision_records_snapshot"
                ON "pr_decision_records" ("last_reconciled_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IX_pr_decision_records_snapshot"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IX_pr_decision_records_org_repo"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "UQ_pr_decision_records_repo_pr_head"
        `);
        await queryRunner.query(`
            DROP TABLE IF EXISTS "pr_decision_records"
        `);
    }
}
