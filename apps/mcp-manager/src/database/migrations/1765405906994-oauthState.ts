import { MigrationInterface, QueryRunner } from 'typeorm';

export class OauthState1765405906994 implements MigrationInterface {
    name = 'OauthState1765405906994';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "mcp-manager"."mcp_integration_oauth_status_enum" AS ENUM('active', 'pending', 'inactive')
        `);
        await queryRunner.query(`
            CREATE TABLE "mcp-manager"."mcp_integration_oauth" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "mcp-manager"."mcp_integration_oauth_status_enum" NOT NULL DEFAULT 'inactive',
                "organizationId" text NOT NULL,
                "integrationId" text NOT NULL,
                "auth" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_d7f6dcde90b772cec356e925f6a" UNIQUE ("organizationId", "integrationId"),
                CONSTRAINT "PK_ba22d5dfa4ce02c74ab42b0a3f9" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "mcp-manager"."mcp_integration_oauth"
        `);
        await queryRunner.query(`
            DROP TYPE "mcp-manager"."mcp_integration_oauth_status_enum"
        `);
    }
}
