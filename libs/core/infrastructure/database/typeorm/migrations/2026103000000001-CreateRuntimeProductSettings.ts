import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product-owned Kody Runtime tables (§8), written only by the API:
 * environments (one per connected repo, uuid = environmentId), the org
 * settings (daily token budget) and the per-repo settings (pilot, who may
 * ask `@kody runtime`).
 */
export class CreateRuntimeProductSettings2026103000000001 implements MigrationInterface {
    name = 'CreateRuntimeProductSettings2026103000000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_environments" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "team_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "repository_name" character varying(512) NOT NULL,
                "state" character varying(32) NOT NULL DEFAULT 'active',
                "setup_requested_at" TIMESTAMP,
                CONSTRAINT "PK_runtime_environments" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_environments_org_repo" ON "runtime_environments" ("organization_id", "repository_id")`,
        );
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_settings" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "token_budget_per_day" bigint,
                CONSTRAINT "PK_runtime_settings" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_settings_org" ON "runtime_settings" ("organization_id")`,
        );
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_repository_settings" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "pilot" boolean NOT NULL DEFAULT false,
                "who_can_ask" character varying(32) NOT NULL DEFAULT 'writers',
                CONSTRAINT "PK_runtime_repository_settings" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_repository_settings_org_repo" ON "runtime_repository_settings" ("organization_id", "repository_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_repository_settings"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_settings"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_environments"`);
    }
}
