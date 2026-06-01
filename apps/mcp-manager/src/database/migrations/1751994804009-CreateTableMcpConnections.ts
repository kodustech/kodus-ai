import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTableMcpConnections1751994804009 implements MigrationInterface {
    name = 'CreateTableMcpConnections1751994804009';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Check if table already exists
        const tableExists = await queryRunner.hasTable(
            'mcp-manager.mcp_connections',
        );

        if (!tableExists) {
            // Create the table (schema already exists from previous migration)
            await queryRunner.query(
                `CREATE TABLE "mcp-manager"."mcp_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" character varying NOT NULL, "integrationId" character varying NOT NULL, "provider" character varying NOT NULL, "status" character varying NOT NULL, "appName" character varying NOT NULL, "mcpUrl" character varying, "allowedTools" jsonb NOT NULL DEFAULT '[]', "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP, CONSTRAINT "PK_23993c4be057f50544ba18f0ff0" PRIMARY KEY ("id"))`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "mcp-manager"."mcp_connections"`);
    }
}
