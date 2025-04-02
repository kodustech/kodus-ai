import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateIntegrationCategory1699645810489
    implements MigrationInterface
{
    name = 'UpdateIntegrationCategory1699645810489';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_integrationcategory_enum"
            RENAME TO "integrations_integrationcategory_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_integrationcategory_enum" AS ENUM(
                'CODE_MANAGEMENT',
                'PROJECT_MANAGEMENT',
                'COMMUNICATION'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "integrationCategory" TYPE "public"."integrations_integrationcategory_enum" USING "integrationCategory"::"text"::"public"."integrations_integrationcategory_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_integrationcategory_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_integrationcategory_enum_old" AS ENUM('REPOSITORY', 'BOARD', 'COMMUNICATION')
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "integrationCategory" TYPE "public"."integrations_integrationcategory_enum_old" USING "integrationCategory"::"text"::"public"."integrations_integrationcategory_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_integrationcategory_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_integrationcategory_enum_old"
            RENAME TO "integrations_integrationcategory_enum"
        `);
    }
}
