import { MigrationInterface, QueryRunner } from "typeorm";

export class SsoTestSession1776881803169 implements MigrationInterface {
    name = 'SsoTestSession1776881803169'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."sso_test_session_protocol_enum" AS ENUM('saml', 'oidc')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."sso_test_session_status_enum" AS ENUM('pending', 'success', 'failed')
        `);
        await queryRunner.query(`
            CREATE TABLE "sso_test_session" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "session_id" text NOT NULL,
                "protocol" "public"."sso_test_session_protocol_enum" NOT NULL,
                "status" "public"."sso_test_session_status_enum" NOT NULL DEFAULT 'pending',
                "config_fingerprint" text NOT NULL,
                "provider_config" jsonb NOT NULL,
                "domains" text array NOT NULL DEFAULT '{}',
                "created_by" text,
                "tested_at" TIMESTAMP,
                "failure_code" text,
                "failure_message" text,
                "expires_at" TIMESTAMP NOT NULL,
                "organization_id" uuid NOT NULL,
                CONSTRAINT "PK_0c49d66a405bdc02a61e7f60d9b" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_SSOTestSession_OrganizationId" ON "sso_test_session" ("organization_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_SSOTestSession_ExpiresAt" ON "sso_test_session" ("expires_at")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_SSOTestSession_SessionId" ON "sso_test_session" ("session_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "sso_test_session"
            ADD CONSTRAINT "FK_a6e96f2999ff6bf4c5fd283e4fd" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_test_session" DROP CONSTRAINT "FK_a6e96f2999ff6bf4c5fd283e4fd"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_SSOTestSession_SessionId"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_SSOTestSession_ExpiresAt"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_SSOTestSession_OrganizationId"
        `);
        await queryRunner.query(`
            DROP TABLE "sso_test_session"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."sso_test_session_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."sso_test_session_protocol_enum"
        `);
    }

}
