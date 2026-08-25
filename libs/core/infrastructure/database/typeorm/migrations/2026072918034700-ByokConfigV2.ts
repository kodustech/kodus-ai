import { MigrationInterface, QueryRunner } from 'typeorm';

import { migrateLegacyToV2 } from '@libs/llm/migrate-byok-config';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
} from '@libs/llm/byok-config';

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

        for (const row of rows ?? []) {
            // Idempotent: already-v2 rows are left untouched (safe to re-run).
            if (isByokConfig(row.configValue)) continue;

            const migrated = migrateLegacyToV2(row.configValue);
            await queryRunner.query(
                `UPDATE "organization_parameters" SET "configValue" = $1::jsonb WHERE "uuid" = $2`,
                [JSON.stringify(migrated), row.uuid],
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
            if (!cred || cred.managed || !cred.apiKey) return undefined;
            const settings = (cred.settings ?? {}) as Record<string, unknown>;
            return {
                provider: cred.provider,
                apiKey: cred.apiKey, // ciphertext verbatim
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
