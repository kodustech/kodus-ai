import { migrateRule } from '@libs/core/infrastructure/database/mongo/kody-rules/migrate-origin-request-type';
import {
    KodyRuleRequestType,
    KodyRulesOrigin,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('migrate-kody-rules backfill — migrateRule', () => {
    it('maps legacy generated origin → past_reviews', () => {
        expect(migrateRule({ origin: 'generated' })?.origin).toBe(
            KodyRulesOrigin.PAST_REVIEWS,
        );
    });

    it('maps legacy user origin → manual', () => {
        expect(migrateRule({ origin: 'user' })?.origin).toBe(
            KodyRulesOrigin.MANUAL,
        );
    });

    it('maps a legacy rule with an IDE sourcePath → repo_file_sync', () => {
        expect(
            migrateRule({ origin: 'user', sourcePath: '.cursorrules' })?.origin,
        ).toBe(KodyRulesOrigin.REPO_FILE_SYNC);
    });

    it('backfills a missing origin → manual', () => {
        expect(migrateRule({ title: 'x' })?.origin).toBe(
            KodyRulesOrigin.MANUAL,
        );
    });

    it('normalizes requestType values', () => {
        expect(migrateRule({ requestType: 'memory_update' })?.requestType).toBe(
            KodyRuleRequestType.UPDATE,
        );
        expect(migrateRule({ requestType: 'memory_create' })?.requestType).toBe(
            KodyRuleRequestType.CREATE,
        );
    });

    it('is idempotent — already-migrated rules are skipped (returns null)', () => {
        expect(
            migrateRule({
                origin: KodyRulesOrigin.PAST_REVIEWS,
                requestType: KodyRuleRequestType.UPDATE,
            }),
        ).toBeNull();
        expect(migrateRule({ origin: KodyRulesOrigin.MANUAL })).toBeNull();
    });

    it('preserves other rule fields', () => {
        const result = migrateRule({
            origin: 'generated',
            title: 'No console.log',
            rule: 'Do not commit console.log',
        });
        expect(result).toMatchObject({
            title: 'No console.log',
            rule: 'Do not commit console.log',
            origin: KodyRulesOrigin.PAST_REVIEWS,
        });
    });
});
