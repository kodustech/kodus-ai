import { describe, expect, it } from 'vitest';
import {
    addRepositoryPattern,
    removeRepositoryPattern,
    SUPPORTED_REPO_PATTERN_FIELDS,
} from '../repo-settings-patterns.js';

const baseSettings = {
    reviewEnabled: true,
    autoApproveEnabled: false,
    requestChangesMinSeverity: 'critical' as const,
    ignoredFilePatterns: ['**/*.lock'],
    baseBranchPatterns: ['main', 'release/*'],
    ignoredTitlePatterns: ['wip*'],
};

describe('repo settings patterns', () => {
    it('exposes the supported pattern fields', () => {
        expect(SUPPORTED_REPO_PATTERN_FIELDS).toEqual([
            'ignore-files',
            'base-branches',
            'ignore-titles',
        ]);
    });

    it('adds a pattern without duplicating existing values', () => {
        expect(
            addRepositoryPattern(baseSettings, 'ignore-files', 'dist/**'),
        ).toEqual({
            ...baseSettings,
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
        });

        expect(
            addRepositoryPattern(baseSettings, 'ignore-files', '**/*.lock'),
        ).toEqual(baseSettings);
    });

    it('removes a pattern from the selected field', () => {
        expect(
            removeRepositoryPattern(baseSettings, 'base-branches', 'release/*'),
        ).toEqual({
            ...baseSettings,
            baseBranchPatterns: ['main'],
        });
    });

    it('fails with a helpful error for unsupported fields', () => {
        expect(() =>
            addRepositoryPattern(baseSettings, 'severity', 'critical'),
        ).toThrow("Unsupported pattern field 'severity'");
    });
});
