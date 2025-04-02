import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAuthDetailsAndProvider1733761185388 implements MigrationInterface {
    name = 'AddAuthDetailsAndProvider1733761185388'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "auth"
            ADD "authDetails" jsonb
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."auth_authprovider_enum" AS ENUM('credentials', 'google', 'github', 'gitlab')
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ADD "authProvider" "public"."auth_authprovider_enum" NOT NULL DEFAULT 'credentials'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "auth" DROP COLUMN "authProvider"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."auth_authprovider_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth" DROP COLUMN "authDetails"
        `);
    }

}
