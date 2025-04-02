import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationMetrics1714491067998 implements MigrationInterface {
    name = 'AddOrganizationMetrics1714491067998'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."organization_metrics_type_enum" AS ENUM(
                'leadTime',
                'cycleTime',
                'leadTimeInWip',
                'leadTimeByColumn',
                'leadTimeForChange',
                'throughput',
                'bugRatio',
                'predictedDeliveryDates',
                'leadTimeInWipByItemType',
                'leadTimeByItemType'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "organization_metrics" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "type" "public"."organization_metrics_type_enum" NOT NULL,
                "value" jsonb NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "organization_id" uuid,
                CONSTRAINT "PK_9e90119e8902f7d5feecdc9e869" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_metrics"
            ADD CONSTRAINT "FK_ffa67a38493b8e6b47b035301b1" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_metrics" DROP CONSTRAINT "FK_ffa67a38493b8e6b47b035301b1"
        `);
        await queryRunner.query(`
            DROP TABLE "organization_metrics"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_metrics_type_enum"
        `);
    }

}
