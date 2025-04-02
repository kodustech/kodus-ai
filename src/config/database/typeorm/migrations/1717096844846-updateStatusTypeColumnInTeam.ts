import { MigrationInterface, QueryRunner } from 'typeorm';
import { STATUS } from '@/config/types/database/status.type';

export class UpdateStatusTypeColumnInTeam1717096844846
    implements MigrationInterface
{
    name = 'UpdateStatusTypeColumnInTeam1717096844846';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Cria o novo tipo ENUM para status
        await queryRunner.query(`
            CREATE TYPE "public"."teams_status_enum" AS ENUM('active', 'inactive', 'pending', 'removed')
        `);

        // Renomeia a coluna status para old_status
        await queryRunner.query(`
            ALTER TABLE "teams"
            RENAME COLUMN "status" TO "old_status"
        `);

        // Adiciona a nova coluna status com o tipo ENUM
        await queryRunner.query(`
            ALTER TABLE "teams"
            ADD "status" "public"."teams_status_enum" NOT NULL DEFAULT 'pending'
        `);

        // Atualiza os registros existentes com cast explícito
        await queryRunner.query(`
            UPDATE "teams"
            SET "status" = CASE
                WHEN "old_status" = true THEN 'active'::teams_status_enum
                WHEN "old_status" = false THEN 'inactive'::teams_status_enum
                ELSE 'pending'::teams_status_enum
            END
        `);

        // Remove a coluna old_status
        await queryRunner.query(`
            ALTER TABLE "teams" DROP COLUMN "old_status"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Adiciona a coluna old_status de volta
        await queryRunner.query(`
            ALTER TABLE "teams"
            ADD "old_status" boolean NOT NULL DEFAULT true
        `);

        // Atualiza os registros para refletir o valor booleano com cast explícito
        await queryRunner.query(`
            UPDATE "teams"
            SET "old_status" = CASE
                WHEN "status" = 'active'::teams_status_enum THEN true
                WHEN "status" = 'inactive'::teams_status_enum THEN false
                ELSE true
            END
        `);

        // Remove a nova coluna status
        await queryRunner.query(`
            ALTER TABLE "teams" DROP COLUMN "status"
        `);

        // Renomeia a coluna old_status de volta para status
        await queryRunner.query(`
            ALTER TABLE "teams"
            RENAME COLUMN "old_status" TO "status"
        `);

        // Remove o tipo ENUM
        await queryRunner.query(`
            DROP TYPE "public"."teams_status_enum"
        `);
    }
}
