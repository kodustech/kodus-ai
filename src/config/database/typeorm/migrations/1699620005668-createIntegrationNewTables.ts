import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIntegrationNewTables1699620005668
    implements MigrationInterface
{
    name = 'CreateIntegrationNewTables1699620005668';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."integration_configs_configkey_enum" AS ENUM(
                'columns_mapping',
                'repositories',
                'channel_info'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "integration_configs" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "configKey" "public"."integration_configs_configkey_enum" NOT NULL,
                "configValue" jsonb NOT NULL,
                "integration_id" uuid NOT NULL,
                CONSTRAINT "PK_51eb1b60290d1ed72416c941806" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "auth_integrations" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "authDetails" jsonb NOT NULL,
                "status" boolean NOT NULL,
                "organization_id" uuid,
                CONSTRAINT "PK_d9b10d059ef2e01261e72563b79" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_platform_enum" AS ENUM('GITHUB', 'JIRA', 'SLACK', 'NOTION')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_integrationcategory_enum" AS ENUM('REPOSITORY', 'BOARD', 'COMMUNICATION')
        `);
        await queryRunner.query(`
            CREATE TABLE "integrations" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "status" boolean NOT NULL,
                "platform" "public"."integrations_platform_enum" NOT NULL,
                "integrationCategory" "public"."integrations_integrationcategory_enum" NOT NULL,
                "organization_id" uuid,
                "auth_integration_id" uuid,
                CONSTRAINT "REL_bcc9e3193d26aa3a235ed4d967" UNIQUE ("auth_integration_id"),
                CONSTRAINT "PK_8eca99e2d796509cc44b241a2d4" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ADD CONSTRAINT "FK_c7d2cd9ac41352d21841db61ec4" FOREIGN KEY ("integration_id") REFERENCES "integrations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "auth_integrations"
            ADD CONSTRAINT "FK_82cf9bd165ff5137a0807984fe1" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD CONSTRAINT "FK_2b83d3671eccf9da46693130ced" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD CONSTRAINT "FK_bcc9e3193d26aa3a235ed4d967b" FOREIGN KEY ("auth_integration_id") REFERENCES "auth_integrations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "integrations" DROP CONSTRAINT "FK_bcc9e3193d26aa3a235ed4d967b"
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations" DROP CONSTRAINT "FK_2b83d3671eccf9da46693130ced"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth_integrations" DROP CONSTRAINT "FK_82cf9bd165ff5137a0807984fe1"
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs" DROP CONSTRAINT "FK_c7d2cd9ac41352d21841db61ec4"
        `);
        await queryRunner.query(`
            DROP TABLE "integrations"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_integrationcategory_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "auth_integrations"
        `);
        await queryRunner.query(`
            DROP TABLE "integration_configs"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integration_configs_configkey_enum"
        `);
    }
}
