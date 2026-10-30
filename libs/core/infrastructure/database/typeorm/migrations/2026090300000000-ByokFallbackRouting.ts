import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-attach the fallback model the v1→v2 BYOK migration left orphaned.
 *
 * `migrateLegacyToV2` converted a legacy `{main, fallback}` blob into v2 by
 * emitting BOTH models — `model-main` and `model-fallback` — and then building
 * routing with only `defaultModelId`. `routing.fallbackModelId` was never set,
 * so the fallback survived as a row in `models[]` that nothing pointed at:
 * visible in the picker, and skipped at runtime because `resolveTaskSlot`
 * returns early when `routing.fallbackModelId` is missing.
 *
 * The effect was silent. An organization that had deliberately configured a
 * fallback kept seeing it listed while it never once ran — including on the
 * days their main model was out of credit or the account was suspended, which
 * is exactly when it existed to run.
 *
 * Measured in production before this migration: of 430 v2 configs, 85 carried
 * a migrated `model-fallback` and 83 of those had no reference to it. The two
 * that were wired had been fixed by hand.
 *
 * Scope is deliberately narrow. It repairs ONLY the id the converter itself
 * emits (`model-fallback`) and ONLY where the reference is absent, so a
 * customer who added a second model and chose to leave the fallback unset is
 * untouched. Idempotent: re-running matches nothing.
 *
 * Cheap by construction — a jsonb update over a few hundred rows, keyed by
 * `configKey`. It does not scan a collection and does not belong to the class
 * of boot-time work that can outlive a container's health check.
 */
export class ByokFallbackRouting2026090300000000 implements MigrationInterface {
    name = 'ByokFallbackRouting2026090300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rows = await queryRunner.query(`
            UPDATE "organization_parameters"
            SET "configValue" = jsonb_set(
                    "configValue",
                    '{routing,fallbackModelId}',
                    '"model-fallback"'::jsonb,
                    true
                )
            WHERE "configKey" = 'byok_config'
              AND "configValue"->>'version' = '2'
              AND jsonb_typeof("configValue"->'routing') = 'object'
              AND ("configValue"->'routing'->>'fallbackModelId') IS NULL
              AND jsonb_typeof("configValue"->'models') = 'array'
              AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements("configValue"->'models') AS m
                  WHERE m->>'id' = 'model-fallback'
              )
            RETURNING organization_id
        `);

        // eslint-disable-next-line no-console
        console.log(
            `[byok-fallback-routing] re-attached the fallback for ${
                Array.isArray(rows) ? rows.length : 0
            } organization(s)`,
        );
    }

    public async down(): Promise<void> {
        // Deliberately a no-op.
        //
        // Once applied, a `fallbackModelId` of "model-fallback" is
        // indistinguishable from one an operator set on purpose — including
        // the two organizations that had already fixed theirs by hand before
        // this ran. Stripping the key on the way down would take their
        // configuration with it, so the reverse of "reference a model that was
        // already there" is to leave it referenced.
    }
}
