import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `egress_fixed_ip` to the `organization_parameters_configkey_enum`
 * Postgres enum: whether the organization's review sandboxes reach its Git
 * host from Kodus's fixed outbound IP (Organization settings). No row is
 * written; an organization without one has it off.
 */
export class AddEgressFixedIpOrgParamEnum2026112400000000 implements MigrationInterface {
    name = 'AddEgressFixedIpOrgParamEnum2026112400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'egress_fixed_ip'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."organization_parameters_configkey_enum"
                        ADD VALUE 'egress_fixed_ip';
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
                        WHERE enumlabel = 'egress_fixed_ip'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "organization_parameters" WHERE "configKey" = 'egress_fixed_ip';

                        ALTER TYPE "public"."organization_parameters_configkey_enum" RENAME TO "organization_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum_old')
                            AND enumlabel <> 'egress_fixed_ip'
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
