import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateAuthIntegrationByTeam1727138706617 implements MigrationInterface {
    name = 'UpdateAuthIntegrationByTeam1727138706617'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "auth_integrations"
            ADD "team_id" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD "team_id" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "auth_integrations"
            ADD CONSTRAINT "FK_d060162c5688db74269445cc69c" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD CONSTRAINT "FK_b72e0311b1a611bd2543c4c67ec" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "integrations" DROP CONSTRAINT "FK_b72e0311b1a611bd2543c4c67ec"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth_integrations" DROP CONSTRAINT "FK_d060162c5688db74269445cc69c"
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations" DROP COLUMN "team_id"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth_integrations" DROP COLUMN "team_id"
        `);
    }

}
