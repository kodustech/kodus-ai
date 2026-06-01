import { describe, expect, it } from 'vitest';
import {
    formatRepositorySettings,
    formatRepositorySetupPreview,
    formatRepositorySetupSection,
} from '../repo-config.js';

describe('repo config formatter', () => {
    it('formats repository settings for terminal display', () => {
        const lines = formatRepositorySettings({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
                sources: {
                    reviewEnabled: {
                        level: 'repository',
                        overriddenLevel: 'global',
                    },
                    autoApproveEnabled: {
                        level: 'repository',
                        overriddenLevel: 'global',
                    },
                    requestChangesMinSeverity: {
                        level: 'global',
                        overriddenLevel: 'default',
                    },
                    ignoredFilePatterns: {
                        level: 'repository',
                        overriddenLevel: 'global',
                    },
                    baseBranchPatterns: {
                        level: 'global',
                        overriddenLevel: 'default',
                    },
                    ignoredTitlePatterns: {
                        level: 'default',
                    },
                },
            },
        });

        const output = lines.join('\n');
        expect(output).toContain('Repository settings: kodustech/cli');
        expect(output).toContain('Status');
        expect(output).toContain('Patterns');
        expect(output).toContain('Automated review: enabled');
        expect(output).toContain('[repository overrides global]');
        expect(output).toContain('Auto approve: disabled');
        expect(output).toContain('Minimum severity level: critical [global overrides default]');
        expect(output).toContain(
            'Ignored file patterns: **/*.lock, dist/** [repository overrides global]',
        );
        expect(output).toContain(
            'Base branch patterns: main, release/* [global overrides default]',
        );
        expect(output).toContain('Ignored title patterns: wip* [default]');
    });

    it('formats repository setup preview for terminal display', () => {
        const lines = formatRepositorySetupPreview(
            'kodustech/cli',
            {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
            {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['draft*'],
            },
        );

        const output = lines.join('\n');
        expect(output).toContain('Review repository settings: kodustech/cli');
        expect(output).toContain(
            'Changed values are highlighted before you apply.',
        );
        expect(output).toContain('Status');
        expect(output).toContain('Patterns');
        expect(output).toContain('· Automated review: enabled');
        expect(output).toContain('+ Auto approve: disabled -> enabled');
        expect(output).toContain(
            '+ Minimum severity level: critical -> high',
        );
        expect(output).toContain(
            '+ Base branch patterns: main -> main, release/*',
        );
        expect(output).toContain('+ Ignored title patterns: wip* -> draft*');
    });

    it('formats setup sections with optional description', () => {
        expect(
            formatRepositorySetupSection(
                'Patterns',
                'Use glob patterns. Examples: **/*.lock, dist/**',
            ),
        ).toEqual([
            '',
            expect.stringContaining('Patterns'),
            expect.stringContaining(
                'Use glob patterns. Examples: **/*.lock, dist/**',
            ),
        ]);
    });
});
