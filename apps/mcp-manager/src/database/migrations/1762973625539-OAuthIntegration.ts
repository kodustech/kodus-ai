import { MigrationInterface, QueryRunner } from 'typeorm';

export class OAuthIntegration1762973625539 implements MigrationInterface {
    name = 'OAuthIntegration1762973625539';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "mcp-manager"."mcp_integrations_authtype_enum"
            RENAME TO "mcp_integrations_authtype_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "mcp-manager"."mcp_integrations_authtype_enum" AS ENUM(
                'none',
                'api_key',
                'basic',
                'bearer_token',
                'oauth2'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType" TYPE "mcp-manager"."mcp_integrations_authtype_enum" USING "authType"::"text"::"mcp-manager"."mcp_integrations_authtype_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType"
            SET DEFAULT 'none'
        `);
        await queryRunner.query(`
            DROP TYPE "mcp-manager"."mcp_integrations_authtype_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "mcp-manager"."mcp_integrations_authtype_enum_old" AS ENUM('api_key', 'basic', 'bearer_token', 'none')
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType" TYPE "mcp-manager"."mcp_integrations_authtype_enum_old" USING "authType"::"text"::"mcp-manager"."mcp_integrations_authtype_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "mcp-manager"."mcp_integrations"
            ALTER COLUMN "authType"
            SET DEFAULT 'none'
        `);
        await queryRunner.query(`
            DROP TYPE "mcp-manager"."mcp_integrations_authtype_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "mcp-manager"."mcp_integrations_authtype_enum_old"
            RENAME TO "mcp_integrations_authtype_enum"
        `);
    }
}
