import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateMetricsColumn1696359216917 implements MigrationInterface {
    name = 'UpdateMetricsColumn1696359216917';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "metrics"
                RENAME COLUMN "platformName" TO "type"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."metrics_platformname_enum"
            RENAME TO "metrics_type_enum"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."metrics_type_enum"
            RENAME TO "metrics_platformname_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
                RENAME COLUMN "type" TO "platformName"
        `);
    }
}
