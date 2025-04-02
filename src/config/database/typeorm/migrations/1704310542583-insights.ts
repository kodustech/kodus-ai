import { MigrationInterface, QueryRunner } from 'typeorm';

export class Insights1704310542583 implements MigrationInterface {
    name = 'Insights1704310542583';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."insights_insighttype_enum" AS ENUM(
                'WipLimit',
                'TaskClearDescription',
                'TaskConsistencySize',
                'TimeWaitingColumns',
                'BugRatio',
                'TaskWithOwner',
                'LeadTime',
                'Throughput'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "insights" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "description" jsonb NOT NULL,
                "weekSumarization" jsonb NOT NULL,
                "conditionals" jsonb,
                "status" boolean NOT NULL DEFAULT true,
                "insightType" "public"."insights_insighttype_enum" NOT NULL,
                "algorithmWeight" double precision NOT NULL DEFAULT '0',
                CONSTRAINT "UQ_ef7db458c0716101f9984563245" UNIQUE ("insightType"),
                CONSTRAINT "PK_89a14374218e9b414171e92d0ae" PRIMARY KEY ("uuid")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "insights"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."insights_insighttype_enum"
        `);
    }
}
