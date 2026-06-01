import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `telemetry_state` to the `global_parameters_configkey_enum` Postgres
 * enum so the self-hosted beacon can persist its singleton state row
 * (`instance_id`, `first_seen_at`, `last_sent_day`) via
 * `GlobalParametersService.createOrUpdateConfig`.
 *
 * TypeORM cannot auto-generate `ALTER TYPE ... ADD VALUE` migrations, so this
 * is hand-written following the same pattern as
 * `2026042900200-addFirstReviewAtOrgParamEnum.ts`.
 */
export class AddTelemetryStateGlobalParam2026050100000
    implements MigrationInterface
{
    name = 'AddTelemetryStateGlobalParam2026050100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'telemetry_state'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."global_parameters_configkey_enum"
                        ADD VALUE 'telemetry_state';
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
                        WHERE enumlabel = 'telemetry_state'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "global_parameters" WHERE "configKey" = 'telemetry_state';

                        ALTER TYPE "public"."global_parameters_configkey_enum" RENAME TO "global_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum_old')
                            AND enumlabel <> 'telemetry_state'
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
