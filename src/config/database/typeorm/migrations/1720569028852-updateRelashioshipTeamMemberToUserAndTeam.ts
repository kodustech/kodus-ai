import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateRelashioshipTeamMemberToUserAndTeam1720569028852 implements MigrationInterface {
    name = 'UpdateRelashioshipTeamMemberToUserAndTeam1720569028852'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "FK_0724b86622f89c433dee4cd8b17"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "REL_0724b86622f89c433dee4cd8b1"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "FK_0724b86622f89c433dee4cd8b17" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "FK_0724b86622f89c433dee4cd8b17"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "REL_0724b86622f89c433dee4cd8b1" UNIQUE ("user_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "FK_0724b86622f89c433dee4cd8b17" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

}
