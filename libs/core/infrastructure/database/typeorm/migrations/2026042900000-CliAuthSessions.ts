import { MigrationInterface, QueryRunner } from 'typeorm';

export class CliAuthSessions2026042900000 implements MigrationInterface {
    name = 'CliAuthSessions2026042900000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "cli_auth_sessions" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "state" varchar(64) NOT NULL,
                "device_code" varchar(64),
                "user_code" varchar(16),
                "redirect_uri" varchar(255),
                "mode" varchar(16) NOT NULL DEFAULT 'loopback',
                "status" varchar(16) NOT NULL DEFAULT 'pending',
                "access_token" text,
                "refresh_token" text,
                "user_id" uuid,
                "user_email" varchar(255),
                "user_agent" varchar(255),
                "expires_at" timestamp NOT NULL,
                "consumed_at" timestamp,
                "completed_at" timestamp,
                "createdAt" timestamp NOT NULL DEFAULT now(),
                "updatedAt" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_cli_auth_sessions_uuid" PRIMARY KEY ("uuid")
            )
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_cli_auth_sessions_state"
            ON "cli_auth_sessions" ("state")
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_cli_auth_sessions_device_code"
            ON "cli_auth_sessions" ("device_code")
            WHERE "device_code" IS NOT NULL
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_cli_auth_sessions_user_code"
            ON "cli_auth_sessions" ("user_code")
            WHERE "user_code" IS NOT NULL AND "status" = 'pending'
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_cli_auth_sessions_status_expires"
            ON "cli_auth_sessions" ("status", "expires_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "cli_auth_sessions"`);
    }
}
