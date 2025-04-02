import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateTeamMemberColumnName1731264230970 implements MigrationInterface {
    name = 'UpdateTeamMemberColumnName1731264230970'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ALTER COLUMN "communicationId" DROP NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ALTER COLUMN "communicationId"
            SET NOT NULL
        `);
    }

}
