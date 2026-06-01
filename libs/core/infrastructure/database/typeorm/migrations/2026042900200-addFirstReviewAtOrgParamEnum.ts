import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `first_review_at` to the `organization_parameters_configkey_enum`
 * Postgres enum so the org-level "first review" milestone marker can be
 * persisted. Without this, `OrganizationParametersService.createOrUpdateConfig`
 * would fail with a Postgres enum constraint error and the milestone would be
 * silently lost (the safeCall in CodeReviewHandlerService swallows it).
 *
 * TypeORM cannot auto-generate `ALTER TYPE ... ADD VALUE` migrations, so this
 * is hand-written following the same pattern as
 * `2026031600000-addIpE2bEnumValue.ts`.
 */
export class AddFirstReviewAtOrgParamEnum2026042900200
    implements MigrationInterface
{
    name = 'AddFirstReviewAtOrgParamEnum2026042900200';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'first_review_at'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."organization_parameters_configkey_enum"
                        ADD VALUE 'first_review_at';
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
                        WHERE enumlabel = 'first_review_at'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "organization_parameters" WHERE "configKey" = 'first_review_at';

                        ALTER TYPE "public"."organization_parameters_configkey_enum" RENAME TO "organization_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum_old')
                            AND enumlabel <> 'first_review_at'
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
