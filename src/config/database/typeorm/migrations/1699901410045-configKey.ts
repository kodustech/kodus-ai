import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConfigKey1699901410045 implements MigrationInterface {
    name = 'ConfigKey1699901410045';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            RENAME TO "integration_configs_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integration_configs_configkey_enum" AS ENUM(
                'columns_mapping',
                'repositories',
                'installation_github',
                'channel_info'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ALTER COLUMN "configKey" TYPE "public"."integration_configs_configkey_enum" USING "configKey"::"text"::"public"."integration_configs_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integration_configs_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."integration_configs_configkey_enum_old" AS ENUM(
                'columns_mapping',
                'repositories',
                'channel_info'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ALTER COLUMN "configKey" TYPE "public"."integration_configs_configkey_enum_old" USING "configKey"::"text"::"public"."integration_configs_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integration_configs_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum_old"
            RENAME TO "integration_configs_configkey_enum"
        `);
    }
}
