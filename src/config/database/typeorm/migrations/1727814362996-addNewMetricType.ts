import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNewMetricType1727814362996 implements MigrationInterface {
    name = 'AddNewMetricType1727814362996'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."organization_metrics_type_enum"
            RENAME TO "organization_metrics_type_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_metrics_type_enum" AS ENUM(
                'leadTime',
                'cycleTime',
                'leadTimeInWip',
                'leadTimeByColumn',
                'throughput',
                'bugRatio',
                'predictedDeliveryDates',
                'leadTimeInWipByItemType',
                'leadTimeByItemType',
                'newWorkItems',
                'deployFrequency',
                'leadTimeForChange'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_metrics"
            ALTER COLUMN "type" TYPE "public"."organization_metrics_type_enum" USING "type"::"text"::"public"."organization_metrics_type_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_metrics_type_enum_old"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."metrics_type_enum"
            RENAME TO "metrics_type_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."metrics_type_enum" AS ENUM(
                'leadTime',
                'cycleTime',
                'leadTimeInWip',
                'leadTimeByColumn',
                'throughput',
                'bugRatio',
                'predictedDeliveryDates',
                'leadTimeInWipByItemType',
                'leadTimeByItemType',
                'newWorkItems',
                'deployFrequency',
                'leadTimeForChange'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
            ALTER COLUMN "type" TYPE "public"."metrics_type_enum" USING "type"::"text"::"public"."metrics_type_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."metrics_type_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."metrics_type_enum_old" AS ENUM(
                'bugRatio',
                'cycleTime',
                'deployFrequency',
                'leadTime',
                'leadTimeByColumn',
                'leadTimeByItemType',
                'leadTimeForChange',
                'leadTimeInWip',
                'leadTimeInWipByItemType',
                'predictedDeliveryDates',
                'throughput'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
            ALTER COLUMN "type" TYPE "public"."metrics_type_enum_old" USING "type"::"text"::"public"."metrics_type_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."metrics_type_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."metrics_type_enum_old"
            RENAME TO "metrics_type_enum"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_metrics_type_enum_old" AS ENUM(
                'bugRatio',
                'cycleTime',
                'deployFrequency',
                'leadTime',
                'leadTimeByColumn',
                'leadTimeByItemType',
                'leadTimeForChange',
                'leadTimeInWip',
                'leadTimeInWipByItemType',
                'predictedDeliveryDates',
                'throughput'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_metrics"
            ALTER COLUMN "type" TYPE "public"."organization_metrics_type_enum_old" USING "type"::"text"::"public"."organization_metrics_type_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_metrics_type_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_metrics_type_enum_old"
            RENAME TO "organization_metrics_type_enum"
        `);
    }

}
