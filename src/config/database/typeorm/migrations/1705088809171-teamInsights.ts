import { MigrationInterface, QueryRunner } from 'typeorm';

export class TeamInsights1705088809171 implements MigrationInterface {
    name = 'TeamInsights1705088809171';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "team_insights" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "values" jsonb NOT NULL,
                "version" integer NOT NULL,
                "team_id" uuid,
                CONSTRAINT "PK_208f67d650325db20bc160f0a6c" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "team_insights"
            ADD CONSTRAINT "FK_ca27101cf6421d84a2b54603ce5" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_insights" DROP CONSTRAINT "FK_ca27101cf6421d84a2b54603ce5"
        `);
        await queryRunner.query(`
            DROP TABLE "team_insights"
        `);
    }
}
