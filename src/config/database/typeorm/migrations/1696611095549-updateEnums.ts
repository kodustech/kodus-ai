import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateEnums1696611095549 implements MigrationInterface {
    name = 'UpdateEnums1696611095549';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."metrics_type_enum"
            RENAME TO "metrics_type_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."metrics_type_enum" AS ENUM(
                'leadTime',
                'cycleTime',
                'leadTimeForChange',
                'throughput',
                'bugRatio',
                'predictedDeliveryDates'
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
                'leadTime',
                'cycleTime',
                'leadTimeForChange',
                'throughput',
                'bugRatio'
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
    }
}
