import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTablePlatformWebhhoks1697413194736
    implements MigrationInterface
{
    name = 'CreateTablePlatformWebhhoks1697413194736';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."platform_webhooks_platform_enum" AS ENUM('GITHUB', 'JIRA', 'SLACK', 'NOTION')
        `);
        await queryRunner.query(`
            CREATE TABLE "platform_webhooks" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "platform" "public"."platform_webhooks_platform_enum" NOT NULL,
                "data" jsonb,
                "team_id" uuid,
                CONSTRAINT "PK_27780dd43d29b8e67d4fa977cb2" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "platform_webhooks"
            ADD CONSTRAINT "FK_76deb2118003f174d0b3ab1f514" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform_webhooks" DROP CONSTRAINT "FK_76deb2118003f174d0b3ab1f514"
        `);
        await queryRunner.query(`
            DROP TABLE "platform_webhooks"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."platform_webhooks_platform_enum"
        `);
    }
}
