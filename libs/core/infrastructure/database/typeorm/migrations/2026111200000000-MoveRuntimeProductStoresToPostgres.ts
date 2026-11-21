import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the product-side stores that lived in the product Mongo move
 * to the product Postgres. Written by the API and the product worker only;
 * the Runtime never reads them.
 *
 * - runtime_model_turn_receipts, runtime_recipe_author_receipts,
 *   runtime_setup_call_counts: what a resumed workflow or a restarted API asks
 *   again; each row expires with the token it was asked with (expires_at).
 * - runtime_llm_budget, runtime_llm_reservations: the gateway's budget (S-47);
 *   only the per-day counter and the reservations expire.
 * - runtime_env_audit: every env_exec / env_fix of a team key (S-27), 90 days.
 * - runtime_publications, runtime_pr_comments: what the product worker
 *   published on the PR for a Run (ADR-052), kept for good.
 *
 * Mongo's TTL indexes become RuntimeProductRetentionCron (a periodic delete)
 * on the expires_at / at indexes below. No data is copied: these stores start
 * empty (no customer depends on them yet).
 */
export class MoveRuntimeProductStoresToPostgres2026111200000000 implements MigrationInterface {
    name = 'MoveRuntimeProductStoresToPostgres2026111200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_model_turn_receipts" (
                "key" text NOT NULL,
                "fingerprint" text NOT NULL,
                "response" jsonb,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_model_turn_receipts" PRIMARY KEY ("key")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_model_turn_receipts_expires" ON "runtime_model_turn_receipts" ("expires_at")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_recipe_author_receipts" (
                "key" text NOT NULL,
                "fingerprint" text NOT NULL,
                "owner" text NOT NULL,
                "lease_until" TIMESTAMP WITH TIME ZONE NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "reservation" jsonb,
                "outcome" jsonb,
                CONSTRAINT "PK_runtime_recipe_author_receipts" PRIMARY KEY ("key")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_recipe_author_receipts_expires" ON "runtime_recipe_author_receipts" ("expires_at")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_setup_call_counts" (
                "key" text NOT NULL,
                "count" integer NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_setup_call_counts" PRIMARY KEY ("key")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_setup_call_counts_expires" ON "runtime_setup_call_counts" ("expires_at")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_llm_budget" (
                "key" text NOT NULL,
                "tokens" bigint NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE,
                "by_model" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_runtime_llm_budget" PRIMARY KEY ("key")
            )
        `);
        // Only the per-day counters expire; the Run and PR counters are the totals the dashboard reads.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_llm_budget_expires" ON "runtime_llm_budget" ("expires_at") WHERE "expires_at" IS NOT NULL`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_llm_reservations" (
                "reservation_id" uuid NOT NULL,
                "run_id" text NOT NULL,
                "organization_id" text NOT NULL,
                "repository_id" text NOT NULL,
                "pr_number" integer NOT NULL,
                "task" text NOT NULL,
                "at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "counters" text array NOT NULL,
                "tokens" bigint NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_llm_reservations" PRIMARY KEY ("reservation_id")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_llm_reservations_expires" ON "runtime_llm_reservations" ("expires_at")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_env_audit" (
                "audit_id" text NOT NULL,
                "organization_id" text NOT NULL,
                "team_id" text NOT NULL,
                "key_id" text NOT NULL,
                "repository_id" text NOT NULL,
                "kind" text NOT NULL,
                "outcome" text NOT NULL,
                "at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "record" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_runtime_env_audit" PRIMARY KEY ("audit_id")
            )
        `);
        // The audit screen (org, kind, newest first), the env_exec quota (accepted ones of an org or a key, since an hour),
        // and the 90-day retention.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_env_audit_org_kind_at" ON "runtime_env_audit" ("organization_id", "kind", "at" DESC)`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_env_audit_quota" ON "runtime_env_audit" ("organization_id", "key_id", "kind", "outcome", "at" DESC)`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_runtime_env_audit_at" ON "runtime_env_audit" ("at")`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_publications" (
                "key" text NOT NULL,
                "run_id" text NOT NULL,
                "attempt" integer NOT NULL,
                "kind" text NOT NULL,
                "organization_id" text NOT NULL,
                "team_id" text NOT NULL,
                "repository_id" text NOT NULL,
                "pr_number" integer NOT NULL,
                "head_sha" text NOT NULL,
                "status" text NOT NULL,
                "lease_until" TIMESTAMP WITH TIME ZONE,
                "check_rank" integer,
                "detail" jsonb NOT NULL DEFAULT '{}',
                "request" jsonb,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_publications" PRIMARY KEY ("key")
            )
        `);
        // The Run page reads a Run's rows; the redrive sweeper scans the stale final ones, oldest first.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_publications_run" ON "runtime_publications" ("organization_id", "run_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_publications_redrive" ON "runtime_publications" ("updated_at") WHERE "request" IS NOT NULL AND "status" IN ('failed', 'publishing')`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_pr_comments" (
                "organization_id" text NOT NULL,
                "repository_id" text NOT NULL,
                "pr_number" integer NOT NULL,
                "team_id" text NOT NULL,
                "comment" jsonb,
                -- The Run's request time in ms x 10 plus the phase (commentOrderOf): past int4.
                "comment_order" bigint,
                "create_pending" boolean,
                "lease_owner" text,
                "lease_until" TIMESTAMP WITH TIME ZONE,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_pr_comments" PRIMARY KEY ("organization_id", "repository_id", "pr_number")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of [
            'runtime_pr_comments',
            'runtime_publications',
            'runtime_env_audit',
            'runtime_llm_reservations',
            'runtime_llm_budget',
            'runtime_setup_call_counts',
            'runtime_recipe_author_receipts',
            'runtime_model_turn_receipts',
        ]) {
            await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
        }
    }
}
