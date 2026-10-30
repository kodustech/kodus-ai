import { MigrationInterface, QueryRunner } from 'typeorm';

import { migrateLegacyToV2 } from '@libs/llm/migrate-byok-config';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { resolveDefaultSlot } from '@libs/llm/resolve-model-slot';

/**
 * Whether a legacy blob CARRIED a BYOK intent — a main/fallback slot with a
 * provider + model. Used only for the migration's own audit log: a row that had
 * slot data but migrates to an EMPTY (managed/env) config is the exact
 * data-loss signature we want to surface loudly in the deploy log, so a prod
 * incident can be attributed to (or cleared of) THIS migration in one grep.
 */
function legacyHadSlotData(blob: unknown): boolean {
    const cfg = (blob && typeof blob === 'object' ? blob : {}) as Record<
        string,
        unknown
    >;
    const slotHasData = (s: unknown): boolean => {
        const slot = (s && typeof s === 'object' ? s : {}) as Record<
            string,
            unknown
        >;
        return (
            typeof slot.provider === 'string' &&
            slot.provider.length > 0 &&
            typeof slot.model === 'string' &&
            slot.model.length > 0
        );
    };
    return slotHasData(cfg.main) || slotHasData(cfg.fallback);
}

/**
 * REQUIRED legacy→v2 BYOK data migration (Phase 04b, plan 04b-07).
 *
 * The v2-only code (slices 04b-01..06) can no longer read a legacy
 * `{main,fallback}` blob — slot resolution returns null for it, so a legacy
 * org would silently resolve to the env/managed default (losing its BYOK key)
 * until migrated. This migration MUST therefore run WITH or BEFORE the v2-only
 * deploy (deploy-coordination confirmed at the blocking checkpoint) — never
 * after, because the Phase 2 dual-read safety net is removed in this slice.
 *
 * Mechanics: iterate every `organization_parameters` row whose `configKey` is the
 * BYOK config key, apply the pure `migrateLegacyToV2` transform, and write the
 * result back as `version:2`. The transform carries key CIPHERTEXT VERBATIM
 * (never re-encrypts) and dedups a shared main/fallback key via an in-memory
 * decrypt-compare that never logs plaintext.
 *
 * Properties:
 *  - Idempotent: a row already `version===2` is SKIPPED — safe to re-run.
 *  - Self-host-safe: plain SQL via the queryRunner, NO Kodus-cloud/service
 *    dependency. An env-only self-host org has no BYOK row → untouched.
 *  - Best-effort down(): re-expands a config blob toward `{main,fallback}` (first
 *    model+credential → main, second → fallback). A precise inverse is NOT
 *    guaranteed once main/fallback were deduped into one credential (the
 *    fallback slot's original provider/settings, if they ever differed, are not
 *    recoverable); it re-encrypts NOTHING (ciphertext carried verbatim).
 */
const BYOK_CONFIG_KEY = 'byok_config';

export class ByokConfigV22026072918034700 implements MigrationInterface {
    name = 'ByokConfigV22026072918034700';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rows: Array<{ uuid: string; configValue: unknown }> =
            await queryRunner.query(
                `SELECT "uuid", "configValue" FROM "organization_parameters" WHERE "configKey" = $1`,
                [BYOK_CONFIG_KEY],
            );

        // Audit counters — logged as one summary line at the end (and a WARN per
        // suspicious row) so a prod deploy can confirm at a glance that this
        // data-path migration preserved every org's BYOK, and any post-deploy
        // incident can be attributed to it (or cleared) with a single
        // `[ByokConfigV2]` grep.
        const tag = '[ByokConfigV2]';
        let total = 0;
        let skippedAlreadyV2 = 0;
        let migratedWithByok = 0; // migrated → has ≥1 credential (BYOK preserved)
        let migratedToManaged = 0; // migrated → empty (env/managed default)
        let lostByok = 0; // had slot data but migrated to empty — the alarm

        for (const row of rows ?? []) {
            total++;
            // Idempotent: already-v2 rows are left untouched (safe to re-run).
            if (isByokConfig(row.configValue)) {
                skippedAlreadyV2++;
                continue;
            }

            const migrated = migrateLegacyToV2(row.configValue);
            const hasByok = (migrated.credentials ?? []).length > 0;

            if (hasByok) {
                migratedWithByok++;
                // Self-check: a non-empty migrated config MUST resolve to a usable
                // default slot. If it does not, the written blob and the resolver
                // disagree — surface the org loudly rather than let it degrade
                // silently to the env default at review time.
                if (!resolveDefaultSlot(migrated)) {
                    console.warn(
                        `${tag} org ${row.uuid}: migrated config has credentials but does NOT resolve to a slot — verify.`,
                    );
                }
            } else {
                migratedToManaged++;
                // Had a real BYOK slot but migrated to empty → its key is gone.
                // After the 04b fixes this should be zero; if it ever fires, this
                // is the line that pins a prod BYOK regression on the migration.
                if (legacyHadSlotData(row.configValue)) {
                    lostByok++;
                    console.warn(
                        `${tag} org ${row.uuid}: legacy config had slot data but migrated to EMPTY (managed/env default) — BYOK LOST.`,
                    );
                }
            }

            await queryRunner.query(
                `UPDATE "organization_parameters" SET "configValue" = $1::jsonb WHERE "uuid" = $2`,
                [JSON.stringify(migrated), row.uuid],
            );
        }

        console.log(
            `${tag} done: ${total} row(s) — ${migratedWithByok} migrated with BYOK, ` +
                `${migratedToManaged} to managed/env default (${lostByok} of them LOST slot data), ` +
                `${skippedAlreadyV2} already-v2 skipped.`,
        );
        if (lostByok > 0) {
            console.warn(
                `${tag} ⚠ ${lostByok} org(s) LOST BYOK config in this migration — see the per-org WARN lines above.`,
            );
        }
    }

    /**
     * Best-effort inverse: carry a config blob back toward the legacy
     * `{main,fallback}` shape so an older code path could read it. This is NOT a
     * guaranteed exact inverse (deduped credentials cannot be split back), and it
     * re-encrypts nothing — ciphertext is carried verbatim. A non-v2 row is left
     * as-is.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: Array<{ uuid: string; configValue: unknown }> =
            await queryRunner.query(
                `SELECT "uuid", "configValue" FROM "organization_parameters" WHERE "configKey" = $1`,
                [BYOK_CONFIG_KEY],
            );

        for (const row of rows ?? []) {
            if (!isByokConfig(row.configValue)) continue;

            const legacy = this.v2ToLegacyBestEffort(row.configValue);
            await queryRunner.query(
                `UPDATE "organization_parameters" SET "configValue" = $1::jsonb WHERE "uuid" = $2`,
                [JSON.stringify(legacy), row.uuid],
            );
        }
    }

    /** Re-expand a config blob toward `{main,fallback}` (best-effort, no re-encrypt). */
    private v2ToLegacyBestEffort(config: BYOKConfig): {
        main?: Record<string, unknown>;
        fallback?: Record<string, unknown>;
    } {
        const creds = new Map<string, BYOKCredential>(
            (config.credentials ?? [])
                .filter((c) => c && c.id)
                .map((c) => [c.id, c]),
        );
        const models = (config.models ?? []).filter((m) => m && m.id);
        const byId = new Map(models.map((m) => [m.id, m]));
        const mainModel =
            (config.routing?.defaultModelId &&
                byId.get(config.routing.defaultModelId)) ||
            models[0];
        const fallbackModel = models.find((m) => m !== mainModel);

        const slot = (modelId?: string) => {
            const model = modelId ? byId.get(modelId) : undefined;
            if (!model) return undefined;
            const cred = creds.get(model.credentialId);
            if (!cred || cred.managed) return undefined;
            const settings = (cred.settings ?? {}) as Record<string, unknown>;
            // Auth material, mirroring resolve-model-slot.ts / up()'s isUsableSlot:
            // an apiKey OR Amazon Bedrock's bearer token / IAM pair. Gating on
            // apiKey alone dropped every Bedrock credential on rollback.
            const hasAuth =
                !!cred.apiKey ||
                !!settings.awsBearerToken ||
                (!!settings.awsAccessKeyId && !!settings.awsSecretAccessKey);
            if (!hasAuth) return undefined;
            return {
                provider: cred.provider,
                // ciphertext verbatim; absent for aws*-authenticated Bedrock.
                ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
                model: model.model,
                ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
                ...(settings.vertexLocation
                    ? { vertexLocation: settings.vertexLocation }
                    : {}),
                ...(settings.awsRegion ? { awsRegion: settings.awsRegion } : {}),
                ...(settings.awsBearerToken
                    ? { awsBearerToken: settings.awsBearerToken }
                    : {}),
                ...(settings.awsAccessKeyId
                    ? { awsAccessKeyId: settings.awsAccessKeyId }
                    : {}),
                ...(settings.awsSecretAccessKey
                    ? { awsSecretAccessKey: settings.awsSecretAccessKey }
                    : {}),
                ...(settings.awsSessionToken
                    ? { awsSessionToken: settings.awsSessionToken }
                    : {}),
                // OpenRouter provider-pinning back at the legacy slot top-level,
                // where the pre-v2 resolver read it.
                ...(Array.isArray(settings.openrouterProviderOrder) &&
                settings.openrouterProviderOrder.length
                    ? {
                          openrouterProviderOrder:
                              settings.openrouterProviderOrder,
                      }
                    : {}),
                ...(typeof settings.openrouterAllowFallbacks === 'boolean'
                    ? {
                          openrouterAllowFallbacks:
                              settings.openrouterAllowFallbacks,
                      }
                    : {}),
                ...(model.reasoningEffort
                    ? { reasoningEffort: model.reasoningEffort }
                    : {}),
                ...(model.temperature !== undefined
                    ? { temperature: model.temperature }
                    : {}),
                ...(model.maxInputTokens !== undefined
                    ? { maxInputTokens: model.maxInputTokens }
                    : {}),
                ...(model.maxOutputTokens !== undefined
                    ? { maxOutputTokens: model.maxOutputTokens }
                    : {}),
                ...(model.maxConcurrentRequests !== undefined
                    ? { maxConcurrentRequests: model.maxConcurrentRequests }
                    : {}),
            };
        };

        const main = slot(mainModel?.id);
        const fallback = slot(fallbackModel?.id);
        return {
            ...(main ? { main } : {}),
            ...(fallback ? { fallback } : {}),
        };
    }
}
