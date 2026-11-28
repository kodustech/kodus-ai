import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime org secrets (docs/runtime/sandbox.md "Secrets: OpenBao"):
 * the metadata Kodus keeps about each secret, and the audit of every change.
 * The value is never here: it lives in OpenBao, written by the API, which
 * cannot read it back. Product Postgres, written only by the API.
 */
export class CreateRuntimeSecrets2026111200000010 implements MigrationInterface {
    name = 'CreateRuntimeSecrets2026111200000010';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_secrets" (
                "organization_id" character varying(128) NOT NULL,
                "secret_id" character varying(64) NOT NULL,
                "name" character varying(64) NOT NULL,
                "hosts" jsonb NOT NULL,
                "created_by" jsonb NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "updated_by" jsonb NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "value_set_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_secrets" PRIMARY KEY ("organization_id", "secret_id"),
                CONSTRAINT "CHK_runtime_secrets_id" CHECK ("secret_id" ~ '^[a-z][a-z0-9_]{0,63}$' AND "secret_id" = lower("name"))
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_secret_audit" (
                "audit_id" uuid NOT NULL,
                "organization_id" character varying(128) NOT NULL,
                "secret_id" character varying(64) NOT NULL,
                "name" character varying(64) NOT NULL,
                "action" character varying(16) NOT NULL,
                "hosts" jsonb NOT NULL,
                "value_replaced" boolean NOT NULL,
                "actor" jsonb NOT NULL,
                "at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_secret_audit" PRIMARY KEY ("audit_id"),
                CONSTRAINT "CHK_runtime_secret_audit_action" CHECK ("action" IN ('created', 'updated', 'deleted'))
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_secret_audit_org_at" ON "runtime_secret_audit" ("organization_id", "at" DESC)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_secret_audit"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_secrets"`);
    }
}
