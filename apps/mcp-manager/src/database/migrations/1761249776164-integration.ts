import { MigrationInterface, QueryRunner } from 'typeorm';

export class Integration1761249776164 implements MigrationInterface {
    name = 'Integration1761249776164';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "mcp-manager"."mcp_integrations_protocol_enum" AS ENUM('http', 'sse')
        `);
        await queryRunner.query(`
            CREATE TYPE "mcp-manager"."mcp_integrations_authtype_enum" AS ENUM('none', 'api_key', 'basic', 'bearer_token')
        `);
        await queryRunner.query(`
            CREATE TABLE "mcp-manager"."mcp_integrations" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "active" boolean NOT NULL DEFAULT true,
                "organizationId" text NOT NULL,
                "protocol" "mcp-manager"."mcp_integrations_protocol_enum" NOT NULL DEFAULT 'http',
                "baseUrl" text NOT NULL,
                "name" text NOT NULL,
                "description" text,
                "logoUrl" text,
                "authType" "mcp-manager"."mcp_integrations_authtype_enum" NOT NULL DEFAULT 'none',
                "auth" text,
                "headers" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "deletedAt" TIMESTAMP,
                CONSTRAINT "PK_80fa2347175d562971ff7d2fe93" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "mcp-manager"."mcp_integrations"
        `);
        await queryRunner.query(`
            DROP TYPE "mcp-manager"."mcp_integrations_authtype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "mcp-manager"."mcp_integrations_protocol_enum"
        `);
    }
}
