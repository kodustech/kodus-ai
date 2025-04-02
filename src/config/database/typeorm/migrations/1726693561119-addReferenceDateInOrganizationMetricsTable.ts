import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReferenceDateInOrganizationMetricsTable1726693561119 implements MigrationInterface {
    name = 'AddReferenceDateInOrganizationMetricsTable1726693561119'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_metrics"
            ADD "referenceDate" TIMESTAMP DEFAULT ('now'::text)::timestamp(6) with time zone
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_metrics" DROP COLUMN "referenceDate"
        `);
    }

}
