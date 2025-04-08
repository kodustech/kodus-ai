import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTableGlobalParameters1744077377588 implements MigrationInterface {
    name = 'AddTableGlobalParameters1744077377588'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."global_parameters_configkey_enum"
            RENAME TO "global_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM(
                'kody_fine_tuning_config',
                'code_review_max_files'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "global_parameters"
            ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum" USING "configKey"::"text"::"public"."global_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."global_parameters_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."global_parameters_configkey_enum_old" AS ENUM('fine_tuning_threshold')
        `);
        await queryRunner.query(`
            ALTER TABLE "global_parameters"
            ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum_old" USING "configKey"::"text"::"public"."global_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."global_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."global_parameters_configkey_enum_old"
            RENAME TO "global_parameters_configkey_enum"
        `);
    }

}
