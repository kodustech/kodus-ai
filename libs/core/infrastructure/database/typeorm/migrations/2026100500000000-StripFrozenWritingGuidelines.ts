import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    canonical,
    stripFrozenWritingGuidelines,
    withoutPromptOverrides,
} from '@libs/common/utils/strip-frozen-writing-guidelines';

/**
 * Removes stored copies of the writing guidelines Kody shipped
 * (`v2PromptOverrides.generation.main`) from every scope of code_review_config.
 *
 * The settings page pre-filled the default, and saving any field on it stored
 * that text as the team's own override. Those teams were frozen on whatever
 * default was current when they saved, so later defaults never reached them.
 * Reviews already read a known copy as the current default and saving no
 * longer stores one; this removes the copies already stored, so the settings
 * page and the stored config show what is actually in effect.
 *
 * A value is removed only when it is one of the shipped texts, ignoring list
 * markers, bold and inline-code markup and whitespace — the same rule reviews
 * use (`matchKnownWritingGuidelines`). Case, punctuation and digits count, so
 * any edit a team made keeps its text. The texts and the rule are frozen in
 * `strip-frozen-writing-guidelines.ts`: an install that upgrades later must
 * remove what was shipped up to now, whatever the defaults become.
 *
 * Every changed row is copied to `parameters_writing_guidelines_backup` first;
 * down() restores the rows that still hold what up() wrote.
 */
const BACKUP_TABLE = 'parameters_writing_guidelines_backup';

export class StripFrozenWritingGuidelines2026100500000000 implements MigrationInterface {
    name = 'StripFrozenWritingGuidelines2026100500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "${BACKUP_TABLE}" (
                uuid uuid PRIMARY KEY,
                original jsonb NOT NULL,
                migrated jsonb NOT NULL,
                "backedUpAt" timestamp NOT NULL DEFAULT now()
            )
        `);

        const rows: Array<{ uuid: string; configValue: unknown }> =
            await queryRunner.query(`
            SELECT uuid, "configValue"
              FROM "parameters"
             WHERE "configKey" = 'code_review_config'
               AND active = true
        `);

        const byMatch: Record<string, number> = {};
        let updated = 0;
        let skipped = 0;
        for (const row of rows) {
            const { value, removed } = stripFrozenWritingGuidelines(
                row.configValue,
            );
            if (!removed.length) continue;

            if (
                withoutPromptOverrides(value) !==
                withoutPromptOverrides(row.configValue)
            ) {
                throw new Error(
                    `StripFrozenWritingGuidelines: row ${row.uuid} would change outside v2PromptOverrides; aborting`,
                );
            }

            // A save since the read deactivated this version or changed it;
            // the newer value wins and this row is left for reviews to read.
            const changed: Array<{ uuid: string }> = await queryRunner.query(
                `WITH changed AS (
                    UPDATE "parameters"
                       SET "configValue" = $1::jsonb, "updatedAt" = NOW()
                     WHERE uuid = $2 AND "configKey" = 'code_review_config' AND active = true
                       AND "configValue" = $3::jsonb
                 RETURNING uuid
                 ) SELECT uuid FROM changed`,
                [
                    JSON.stringify(value),
                    row.uuid,
                    JSON.stringify(row.configValue),
                ],
            );
            if (!changed.length) {
                skipped++;
                console.log(
                    `[StripFrozenWritingGuidelines] row ${row.uuid}: changed since it was read; skipped`,
                );
                continue;
            }
            await queryRunner.query(
                `INSERT INTO "${BACKUP_TABLE}" (uuid, original, migrated)
                 VALUES ($1, $2::jsonb, $3::jsonb)
                 ON CONFLICT (uuid) DO NOTHING`,
                [
                    row.uuid,
                    JSON.stringify(row.configValue),
                    JSON.stringify(value),
                ],
            );

            updated++;
            for (const r of removed)
                byMatch[r.match] = (byMatch[r.match] ?? 0) + 1;
            console.log(
                `[StripFrozenWritingGuidelines] row ${row.uuid}: removed ${removed
                    .map((r) => `${r.level} (${r.match})`)
                    .join(', ')}`,
            );
        }

        console.log(
            `[StripFrozenWritingGuidelines] updated ${updated} of ${rows.length} active code_review_config rows, ${skipped} skipped; levels removed by text: ${JSON.stringify(byMatch)}; originals in "${BACKUP_TABLE}"`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ exists }] = await queryRunner.query(
            `SELECT to_regclass('"${BACKUP_TABLE}"') IS NOT NULL AS exists`,
        );
        if (!exists) return;

        const backups: Array<{
            uuid: string;
            original: unknown;
            migrated: unknown;
            current: unknown;
        }> = await queryRunner.query(`
                SELECT b.uuid, b.original, b.migrated, p."configValue" AS current
                  FROM "${BACKUP_TABLE}" b
                  LEFT JOIN "parameters" p ON p.uuid = b.uuid
            `);

        let restored = 0;
        let leftAsIs = 0;
        for (const backup of backups) {
            // A row saved again since up() holds the team's newer settings.
            if (canonical(backup.current) !== canonical(backup.migrated)) {
                leftAsIs++;
                console.log(
                    `[StripFrozenWritingGuidelines] down: row ${backup.uuid} changed after the migration; left as is`,
                );
                continue;
            }
            await queryRunner.query(
                `UPDATE "parameters"
                    SET "configValue" = $1::jsonb, "updatedAt" = NOW()
                  WHERE uuid = $2 AND "configValue" = $3::jsonb`,
                [
                    JSON.stringify(backup.original),
                    backup.uuid,
                    JSON.stringify(backup.migrated),
                ],
            );
            restored++;
        }

        await queryRunner.query(`DROP TABLE IF EXISTS "${BACKUP_TABLE}"`);
        console.log(
            `[StripFrozenWritingGuidelines] down: restored ${restored}, ${leftAsIs} left as is`,
        );
    }
}
