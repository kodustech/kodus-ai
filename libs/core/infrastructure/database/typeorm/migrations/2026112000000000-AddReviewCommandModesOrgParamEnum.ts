import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `review_command_modes_config` to the
 * `organization_parameters_configkey_enum` Postgres enum: the organization's
 * switches that turn off Heavy and Ultra reviews asked by a PR command. No
 * row is written; an organization without one keeps both commands on.
 */
export class AddReviewCommandModesOrgParamEnum2026112000000000 implements MigrationInterface {
    name = 'AddReviewCommandModesOrgParamEnum2026112000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'review_command_modes_config'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."organization_parameters_configkey_enum"
                        ADD VALUE 'review_command_modes_config';
                    END IF;
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'review_command_modes_config'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "organization_parameters" WHERE "configKey" = 'review_command_modes_config';

                        ALTER TYPE "public"."organization_parameters_configkey_enum" RENAME TO "organization_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum_old')
                            AND enumlabel <> 'review_command_modes_config'
                        );

                        ALTER TABLE "organization_parameters"
                        ALTER COLUMN "configKey" TYPE "public"."organization_parameters_configkey_enum"
                        USING "configKey"::"text"::"public"."organization_parameters_configkey_enum";

                        DROP TYPE "public"."organization_parameters_configkey_enum_old";
                    END IF;
                END IF;
            END $$;
        `);
    }
}
