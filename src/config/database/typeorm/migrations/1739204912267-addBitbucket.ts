import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBitbucket1739204912267 implements MigrationInterface {
    name = 'AddBitbucket1739204912267'

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
                'AZURE_REPOS',
                'KODUS_WEB',
                'BITBUCKET'
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
                'AZURE_BOARDS',
                'AZURE_REPOS',
                'DISCORD',
                'GITHUB',
                'GITLAB',
                'JIRA',
                'KODUS_WEB',
                'MSTEAMS',
                'NOTION',
                'SLACK'
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
