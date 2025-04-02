import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSprintTable1712859472087 implements MigrationInterface {
    name = 'AddSprintTable1712859472087'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."sprint_state_enum" AS ENUM('past', 'closed', 'active', 'future')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."sprint_compilestate_enum" AS ENUM('closed', 'active')
        `);
        await queryRunner.query(`
            CREATE TABLE "sprint" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "projectManagementSprintId" character varying NOT NULL,
                "name" character varying NOT NULL,
                "state" "public"."sprint_state_enum" NOT NULL,
                "compileState" "public"."sprint_compilestate_enum" NOT NULL,
                "startDate" TIMESTAMP,
                "endDate" TIMESTAMP,
                "completeDate" TIMESTAMP,
                "description" character varying,
                "goal" character varying,
                "value" jsonb,
                "team_id" uuid,
                CONSTRAINT "PK_8abcdd3c4e5fcf6161ffb6ef103" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "sprint"
            ADD CONSTRAINT "FK_738321a380b6d8e5266516b5302" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sprint" DROP CONSTRAINT "FK_738321a380b6d8e5266516b5302"
        `);
        await queryRunner.query(`
            DROP TABLE "sprint"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."sprint_compilestate_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."sprint_state_enum"
        `);
    }

}
