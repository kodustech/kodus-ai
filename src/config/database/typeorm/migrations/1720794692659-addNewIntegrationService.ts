import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNewIntegrationService1720794692659 implements MigrationInterface {
    name = 'AddNewIntegrationService1720794692659'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_platform_enum"
            RENAME TO "integrations_platform_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_platform_enum" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD',
                'AZURE_BOARDS',
                'AZURE_DEVOPS'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "platform" TYPE "public"."integrations_platform_enum" USING "platform"::"text"::"public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_platform_enum_old" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD',
                'AZURE_BOARDS'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "platform" TYPE "public"."integrations_platform_enum_old" USING "platform"::"text"::"public"."integrations_platform_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_platform_enum_old"
            RENAME TO "integrations_platform_enum"
        `);
    }

}
