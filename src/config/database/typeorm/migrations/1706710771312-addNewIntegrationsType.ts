import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewIntegrationsType1706710771312 implements MigrationInterface {
    name = 'AddNewIntegrationsType1706710771312';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."organization_platforms_platformname_enum"
            RENAME TO "organization_platforms_platformname_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_platforms_platformname_enum" AS ENUM(
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
            ALTER TABLE "organization_platforms"
            ALTER COLUMN "platformName" TYPE "public"."organization_platforms_platformname_enum" USING "platformName"::"text"::"public"."organization_platforms_platformname_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_platforms_platformname_enum_old"
        `);
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
                'AZURE_BOARDS'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "platform" TYPE "public"."integrations_platform_enum" USING "platform"::"text"::"public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum_old"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."platform_webhooks_platform_enum"
            RENAME TO "platform_webhooks_platform_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."platform_webhooks_platform_enum" AS ENUM(
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
            ALTER TABLE "platform_webhooks"
            ALTER COLUMN "platform" TYPE "public"."platform_webhooks_platform_enum" USING "platform"::"text"::"public"."platform_webhooks_platform_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."platform_webhooks_platform_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."platform_webhooks_platform_enum_old" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "platform_webhooks"
            ALTER COLUMN "platform" TYPE "public"."platform_webhooks_platform_enum_old" USING "platform"::"text"::"public"."platform_webhooks_platform_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."platform_webhooks_platform_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."platform_webhooks_platform_enum_old"
            RENAME TO "platform_webhooks_platform_enum"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_platform_enum_old" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD'
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
        await queryRunner.query(`
            CREATE TYPE "public"."organization_platforms_platformname_enum_old" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_platforms"
            ALTER COLUMN "platformName" TYPE "public"."organization_platforms_platformname_enum_old" USING "platformName"::"text"::"public"."organization_platforms_platformname_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_platforms_platformname_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_platforms_platformname_enum_old"
            RENAME TO "organization_platforms_platformname_enum"
        `);
    }
}
