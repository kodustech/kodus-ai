import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `global_rules_source_repositories` to the
 * `organization_parameters_configkey_enum` Postgres enum so the list of
 * repositories selected as sources of global Kody Rules can be persisted as an
 * organization_parameters row. Without this,
 * `OrganizationParametersService.createOrUpdateConfig` (and any read of the
 * key) fails with `invalid input value for enum ...` and the save endpoint
 * returns 500.
 *
 * TypeORM cannot auto-generate `ALTER TYPE ... ADD VALUE` migrations, so this
 * is hand-written following the same idempotent pattern as
 * `2026042900200-addFirstReviewAtOrgParamEnum.ts`.
 */
export class AddGlobalRulesSourceOrgParamEnum2026072200000000
    implements MigrationInterface
{
    name = 'AddGlobalRulesSourceOrgParamEnum2026072200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'global_rules_source_repositories'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."organization_parameters_configkey_enum"
                        ADD VALUE 'global_rules_source_repositories';
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
                        WHERE enumlabel = 'global_rules_source_repositories'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "organization_parameters" WHERE "configKey" = 'global_rules_source_repositories';

                        ALTER TYPE "public"."organization_parameters_configkey_enum" RENAME TO "organization_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum_old')
                            AND enumlabel <> 'global_rules_source_repositories'
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
