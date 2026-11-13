import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sandbox_concurrency` to the `global_parameters_configkey_enum`
 * Postgres enum. The key was added to `GlobalParametersKey` without it, so
 * the database refused every read and write of the per-worker sandbox limit:
 * the limit could not be set, and the worker ran without one.
 *
 * TypeORM cannot auto-generate `ALTER TYPE ... ADD VALUE` migrations, so this
 * is hand-written following `2026050100000-addTelemetryStateGlobalParam.ts`.
 */
export class AddSandboxConcurrencyGlobalParam2026111300000000 implements MigrationInterface {
    name = 'AddSandboxConcurrencyGlobalParam2026111300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'sandbox_concurrency'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."global_parameters_configkey_enum"
                        ADD VALUE 'sandbox_concurrency';
                    END IF;
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'sandbox_concurrency'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "global_parameters" WHERE "configKey" = 'sandbox_concurrency';

                        ALTER TYPE "public"."global_parameters_configkey_enum" RENAME TO "global_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum_old')
                            AND enumlabel <> 'sandbox_concurrency'
                        );

                        ALTER TABLE "global_parameters"
                        ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum"
                        USING "configKey"::"text"::"public"."global_parameters_configkey_enum";

                        DROP TYPE "public"."global_parameters_configkey_enum_old";
                    END IF;
                END IF;
            END $$;
        `);
    }
}
