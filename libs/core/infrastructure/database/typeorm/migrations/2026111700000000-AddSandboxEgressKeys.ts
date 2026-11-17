import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two keys that decide which egress a sandbox uses:
 *
 * - `egress_fixed_ip` on `integration_configs_configkey_enum`: the team's
 *   Git host only answers our fixed IP, so its sandboxes keep the proxy.
 * - `sandbox_egress` on `global_parameters_configkey_enum`: the rollout of
 *   direct egress (which organizations may leave without the proxy).
 *
 * `ADD VALUE` cannot run inside a transaction block on every Postgres
 * version we support, hence `transaction = false` (same as
 * `2026092400000000-AddWebhookCreationFailuresConfigKey.ts`). Enum values
 * are not removed on `down`: rows may still reference them.
 */
export class AddSandboxEgressKeys2026111700000000 implements MigrationInterface {
    name = 'AddSandboxEgressKeys2026111700000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            ADD VALUE IF NOT EXISTS 'egress_fixed_ip'
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    ALTER TYPE "public"."global_parameters_configkey_enum"
                    ADD VALUE IF NOT EXISTS 'sandbox_egress';
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DELETE FROM "integration_configs" WHERE "configKey" = 'egress_fixed_ip'`,
        );
        await queryRunner.query(
            `DELETE FROM "global_parameters" WHERE "configKey" = 'sandbox_egress'`,
        );
    }
}
