import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIpE2bEnumValue2026031600000 implements MigrationInterface {
    name = 'AddIpE2bEnumValue2026031600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'ip_e2b'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."global_parameters_configkey_enum"
                        ADD VALUE 'ip_e2b';
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
                        WHERE enumlabel = 'ip_e2b'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        -- Delete any data using the value we are about to remove to prevent cast errors
                        DELETE FROM "global_parameters" WHERE "configKey" = 'ip_e2b';

                        -- Rename the existing enum type
                        ALTER TYPE "public"."global_parameters_configkey_enum" RENAME TO "global_parameters_configkey_enum_old";

                        -- Create the new enum type dynamically with all values except 'ip_e2b'
                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum_old')
                            AND enumlabel <> 'ip_e2b'
                        );

                        -- Change the column to use the new enum type
                        ALTER TABLE "global_parameters"
                        ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum"
                        USING "configKey"::"text"::"public"."global_parameters_configkey_enum";

                        -- Drop the old enum type
                        DROP TYPE "public"."global_parameters_configkey_enum_old";
                    END IF;
                END IF;
            END $$;
        `);
    }
}
