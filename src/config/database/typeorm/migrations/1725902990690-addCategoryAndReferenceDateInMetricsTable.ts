import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCategoryAndReferenceDateInMetricsTable1725902990690 implements MigrationInterface {
    name = 'AddCategoryAndReferenceDateInMetricsTable1725902990690'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."metrics_category_enum" AS ENUM('flowMetrics', 'doraMetrics')
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
            ADD "category" "public"."metrics_category_enum" NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
            ADD "referenceDate" TIMESTAMP NULL DEFAULT ('now'::text)::timestamp(6) with time zone
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "metrics" DROP COLUMN "referenceDate"
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics" DROP COLUMN "category"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."metrics_category_enum"
        `);
    }

}
