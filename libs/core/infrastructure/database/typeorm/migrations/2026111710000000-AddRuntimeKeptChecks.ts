import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime kept checks (docs/runtime/kept-checks.md): the probe of a
 * regression a user kept, so every later Run of the repository in that
 * environment plays it again through the same gate. One active check per
 * (org, environment, repository, probe key); a removed check keeps its row
 * (who, when). Product Postgres, written only by the API.
 */
export class AddRuntimeKeptChecks2026111710000000 implements MigrationInterface {
    name = 'AddRuntimeKeptChecks2026111710000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_kept_checks" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "environment_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "probe_key" character varying(1024) NOT NULL,
                "entry_point" character varying(512) NOT NULL,
                "check" jsonb NOT NULL,
                "source_run_id" character varying(128) NOT NULL,
                "source_probe_id" character varying(128) NOT NULL,
                "source_pr_number" integer NOT NULL,
                "kept_by" character varying(128) NOT NULL,
                "removed_at" TIMESTAMP,
                "removed_by" character varying(128),
                CONSTRAINT "PK_runtime_kept_checks" PRIMARY KEY ("uuid"),
                CONSTRAINT "CHK_runtime_kept_checks_removed" CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL))
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_kept_checks_active_key" ON "runtime_kept_checks" ("organization_id", "environment_id", "repository_id", "probe_key") WHERE "removed_at" IS NULL`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_kept_checks_scope" ON "runtime_kept_checks" ("organization_id", "environment_id", "repository_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_kept_checks"`);
    }
}
