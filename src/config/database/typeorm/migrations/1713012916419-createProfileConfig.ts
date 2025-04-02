import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProfileConfig1713012916419 implements MigrationInterface {
    name = 'CreateProfileConfig1713012916419'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."profile_configs_configkey_enum" AS ENUM('user_notifications')
        `);
        await queryRunner.query(`
            CREATE TABLE "profile_configs" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "configKey" "public"."profile_configs_configkey_enum" NOT NULL,
                "configValue" jsonb NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "profile_id" uuid,
                CONSTRAINT "PK_d0aa63bcab8d27db86af079d10e" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "profile_configs"
            ADD CONSTRAINT "FK_b2a4995bc1a788a9b695571540a" FOREIGN KEY ("profile_id") REFERENCES "profiles"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "profile_configs" DROP CONSTRAINT "FK_b2a4995bc1a788a9b695571540a"
        `);
        await queryRunner.query(`
            DROP TABLE "profile_configs"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."profile_configs_configkey_enum"
        `);
    }

}
