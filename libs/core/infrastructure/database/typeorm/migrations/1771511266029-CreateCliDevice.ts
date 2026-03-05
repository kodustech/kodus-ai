import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCliDevice1771511266029 implements MigrationInterface {
    name = 'CreateCliDevice1771511266029';

    // Disable transaction because CONCURRENTLY cannot run inside transaction
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "cli_devices" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "deviceId" character varying NOT NULL,
                "deviceTokenHash" character varying NOT NULL,
                "lastSeenAt" TIMESTAMP,
                "userAgent" character varying,
                "organization_id" uuid,
                "user_id" uuid,
                CONSTRAINT "PK_08df7200e16536be1801fe2ea8d" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY "IDX_cli_device_deviceId_org" ON "cli_devices" ("deviceId", "organization_id")
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY "IDX_cli_device_org" ON "cli_devices" ("organization_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "cli_devices"
            ADD CONSTRAINT "FK_48b5e98fd4d3ea89ec72c3553bf" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "cli_devices"
            ADD CONSTRAINT "FK_96896f50507d3e188375266610b" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "cli_devices" DROP CONSTRAINT "FK_96896f50507d3e188375266610b"
        `);
        await queryRunner.query(`
            ALTER TABLE "cli_devices" DROP CONSTRAINT "FK_48b5e98fd4d3ea89ec72c3553bf"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY "public"."IDX_cli_device_org"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY "public"."IDX_cli_device_deviceId_org"
        `);
        await queryRunner.query(`
            DROP TABLE "cli_devices"
        `);
    }
}
