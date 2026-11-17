import { describe, expect, it } from 'vitest';
import {
    REVIEW_SETTINGS,
    buildConfigDelta,
    legacyAliasFor,
    parseReviewSettingValue,
    resolveReviewSetting,
} from '../review-settings-catalog.js';

describe('review settings catalog', () => {
    it('has one entry per key', () => {
        const keys = REVIEW_SETTINGS.map((setting) => setting.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('leaves out what other commands own or no page edits', () => {
        const keys = REVIEW_SETTINGS.map((setting) => setting.key);
        for (const excluded of [
            'customAgents',
            'byokModelId',
            'byokModel',
            'knowledge',
            'businessLogic.taskSource',
            'businessLogic.taskSourceTool',
            'codeReviewVersion',
        ]) {
            expect(keys).not.toContain(excluded);
        }
    });

    it('resolves the six legacy keys to their config paths', () => {
        expect(resolveReviewSetting('review.enabled').key).toBe(
            'automatedReviewActive',
        );
        expect(
            resolveReviewSetting('review.requestChanges.minSeverity').key,
        ).toBe('suggestionControl.severityLevelFilter');
        expect(resolveReviewSetting('patterns.ignoreTitles').key).toBe(
            'ignoredTitleKeywords',
        );
    });

    it('maps a config path back to its legacy alias, when it has one', () => {
        expect(legacyAliasFor('ignorePaths')).toBe('patterns.ignoreFiles');
        expect(legacyAliasFor('review.autoApprove')).toBe('review.autoApprove');
        expect(legacyAliasFor('summary.generatePRSummary')).toBeUndefined();
    });

    it('rejects an unknown key and points at the key list', () => {
        expect(() => resolveReviewSetting('nope.nope')).toThrow(
            /kodus config remote keys/,
        );
    });

    it('parses each value type and rejects what the API would refuse', () => {
        const bool = resolveReviewSetting('runOnDraft');
        expect(parseReviewSettingValue(bool, 'false')).toBe(false);
        expect(() => parseReviewSettingValue(bool, 'yes')).toThrow(
            /'true' or 'false'/,
        );

        const num = resolveReviewSetting(
            'suggestionControl.severityLimits.low',
        );
        expect(parseReviewSettingValue(num, '3')).toBe(3);
        expect(() => parseReviewSettingValue(num, '-1')).toThrow();
        expect(() => parseReviewSettingValue(num, '')).toThrow();

        const enumSetting = resolveReviewSetting('reviewCadence.type');
        expect(parseReviewSettingValue(enumSetting, 'auto_pause')).toBe(
            'auto_pause',
        );
        expect(() => parseReviewSettingValue(enumSetting, 'weekly')).toThrow(
            /automatic, manual, auto_pause/,
        );

        const limited = resolveReviewSetting('businessLogic.teamGuidance');
        expect(() =>
            parseReviewSettingValue(limited, 'x'.repeat(2001)),
        ).toThrow(/2000/);
    });

    it('takes a list as comma-separated text or a JSON array', () => {
        const list = resolveReviewSetting('baseBranches');
        expect(parseReviewSettingValue(list, 'main, develop')).toEqual([
            'main',
            'develop',
        ]);
        expect(parseReviewSettingValue(list, '["release/*"]')).toEqual([
            'release/*',
        ]);
        expect(parseReviewSettingValue(list, '')).toEqual([]);
        expect(() => parseReviewSettingValue(list, '[1]')).toThrow();
    });

    it('validates linked repositories as objects naming a repository', () => {
        const linked = resolveReviewSetting('linkedRepositories');
        expect(
            parseReviewSettingValue(
                linked,
                '[{"repository":"org/shared","ref":"main"}]',
            ),
        ).toEqual([{ repository: 'org/shared', ref: 'main' }]);
        expect(() =>
            parseReviewSettingValue(linked, '[{"ref":"main"}]'),
        ).toThrow(/repository/);
    });

    it('builds the partial config a save takes from a dot path', () => {
        expect(
            buildConfigDelta('suggestionControl.severityLimits.high', 2),
        ).toEqual({ suggestionControl: { severityLimits: { high: 2 } } });
        expect(buildConfigDelta('runOnDraft', false)).toEqual({
            runOnDraft: false,
        });
    });
});
