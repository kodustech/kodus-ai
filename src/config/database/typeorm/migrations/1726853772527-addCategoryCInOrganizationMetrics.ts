import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCategoryCInOrganizationMetrics1726853772527 implements MigrationInterface {
    name = 'AddCategoryCInOrganizationMetrics1726853772527'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."organization_metrics_category_enum" AS ENUM('flowMetrics', 'doraMetrics')
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_metrics"
            ADD "category" "public"."organization_metrics_category_enum"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_metrics" DROP COLUMN "category"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_metrics_category_enum"
        `);
    }

}
