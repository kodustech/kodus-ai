import { describe, expect, it } from 'vitest';
import {
    applyRepositorySetting,
    parseRepositoryPatternList,
    SUPPORTED_REPO_SETTING_KEYS,
} from '../repo-settings-schema.js';

describe('repo settings schema', () => {
    it('exposes the supported repository setting keys', () => {
        expect(SUPPORTED_REPO_SETTING_KEYS).toEqual([
            'review.enabled',
            'review.autoApprove',
            'review.requestChanges.minSeverity',
            'patterns.ignoreFiles',
            'patterns.baseBranches',
            'patterns.ignoreTitles',
        ]);
    });

    it('parses comma-separated pattern lists', () => {
        expect(parseRepositoryPatternList('**/*.lock, dist/**')).toEqual([
            '**/*.lock',
            'dist/**',
        ]);
    });

    it('parses comma-separated and newline-separated pattern lists together', () => {
        expect(
            parseRepositoryPatternList('**/*.lock,\ndist/**\ncoverage/**'),
        ).toEqual(['**/*.lock', 'dist/**', 'coverage/**']);
    });

    it('applies repository settings by supported key', () => {
        const current = {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical' as const,
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        };

        expect(
            applyRepositorySetting(
                current,
                'review.requestChanges.minSeverity',
                'high',
            ),
        ).toEqual({
            ...current,
            requestChangesMinSeverity: 'high',
        });

        expect(
            applyRepositorySetting(
                current,
                'patterns.ignoreFiles',
                '**/*.lock,dist/**',
            ),
        ).toEqual({
            ...current,
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
        });
    });

    it('fails with a helpful error for unsupported keys', () => {
        expect(() =>
            applyRepositorySetting(
                {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: [],
                    baseBranchPatterns: [],
                    ignoredTitlePatterns: [],
                },
                'review.unknown',
                'true',
            ),
        ).toThrow("Unsupported setting key 'review.unknown'");
    });
});
