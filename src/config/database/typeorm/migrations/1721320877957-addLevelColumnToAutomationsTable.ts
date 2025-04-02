import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLevelColumnToAutomationsTable1721320877957 implements MigrationInterface {
    name = 'AddLevelColumnToAutomationsTable1721320877957'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."automation_level_enum" AS ENUM('ORGANIZATION', 'TEAM')
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ADD "level" "public"."automation_level_enum" NOT NULL DEFAULT 'TEAM'
        `);

        await queryRunner.query(`
            ALTER TABLE "automation"
            ALTER COLUMN "level"
            SET DEFAULT 'TEAM'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "automation" DROP COLUMN "level"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."automation_level_enum"
        `);
    }

}
