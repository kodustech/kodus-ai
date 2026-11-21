import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sandbox_capacity` to the `global_parameters_configkey_enum` Postgres
 * enum: the deployment-wide sandbox cap and queue wait, editable from the
 * self-hosted settings screen. Hand-written like the other enum migrations
 * (TypeORM cannot generate ALTER TYPE ... ADD VALUE).
 */
export class AddSandboxCapacityGlobalParam2026112000000000 implements MigrationInterface {
    name = 'AddSandboxCapacityGlobalParam2026112000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'sandbox_capacity'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."global_parameters_configkey_enum"
                        ADD VALUE 'sandbox_capacity';
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
                        WHERE enumlabel = 'sandbox_capacity'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "global_parameters" WHERE "configKey" = 'sandbox_capacity';

                        ALTER TYPE "public"."global_parameters_configkey_enum" RENAME TO "global_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum_old')
                            AND enumlabel <> 'sandbox_capacity'
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
