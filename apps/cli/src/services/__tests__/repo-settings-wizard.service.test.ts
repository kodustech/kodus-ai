import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@inquirer/prompts', () => ({
    checkbox: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    select: vi.fn(),
}));

import * as prompts from '@inquirer/prompts';
import { repositorySettingsWizardService } from '../repo-settings-wizard.service.js';

const mockCheckbox = vi.mocked(prompts.checkbox);
const mockConfirm = vi.mocked(prompts.confirm);
const mockInput = vi.mocked(prompts.input);
const mockSelect = vi.mocked(prompts.select);

describe('repositorySettingsWizardService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns existing settings without prompting when yes is enabled', async () => {
        const current = {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical' as const,
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        };

        await expect(
            repositorySettingsWizardService.collectSettings(current, {
                yes: true,
                writeLine: vi.fn(),
            }),
        ).resolves.toEqual(current);

        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockCheckbox).not.toHaveBeenCalled();
        expect(mockSelect).not.toHaveBeenCalled();
        expect(mockInput).not.toHaveBeenCalled();
    });

    it('prompts for settings with explanatory copy and recommended ignored files', async () => {
        const writeLine = vi.fn();
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('high')
            .mockResolvedValueOnce('recommended')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply');
        mockCheckbox
            .mockResolvedValueOnce(['main', 'release/*'])
            .mockResolvedValueOnce(['wip*', 'draft*']);

        const result = await repositorySettingsWizardService.collectSettings(
            {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
            {
                writeLine,
            },
        );

        expect(result).toEqual({
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'high',
            ignoredFilePatterns: [
                'yarn.lock',
                'package-lock.json',
                'package.json',
                '.env',
                '**/*.json',
            ],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*', 'draft*'],
        });

        const output = writeLine.mock.calls
            .map((call) => String(call[0]))
            .join('\n');
        expect(output).toContain('General');
        expect(output).toContain(
            'Choose the review behaviors you want for this repository.',
        );
        expect(output).toContain(
            'Kody automatically reviews pull requests when they are opened or updated.',
        );
        expect(output).toContain(
            'Automatically approves the pull request when the review finishes without issues.',
        );
        expect(output).toContain('Patterns');
        expect(output).toContain(
            'Files and titles can use glob patterns. Branches accept branch names or expressions like release/*.',
        );
        expect(output).toContain(
            'Files matching these glob patterns will be skipped during review.',
        );
        expect(output).toContain('Current ignored files: **/*.lock');
        expect(output).toContain(
            'Examples: yarn.lock, package-lock.json, .env, **/*.json',
        );
        expect(output).toContain(
            'Kody skips the review when the pull request title matches one of these patterns.',
        );
        expect(output).toContain(
            'Additional base branches that Kody should review against.',
        );
        expect(output).toContain('Current base branches: main');
        expect(output).toContain(
            'Kody skips the review when the pull request title matches one of these patterns.',
        );
        expect(output).toContain('Current ignored title patterns: wip*');
        expect(mockCheckbox).toHaveBeenCalledTimes(2);
        expect(mockSelect.mock.calls[3]?.[0]).toMatchObject({
            message: 'Ignored files',
            choices: expect.arrayContaining([
                expect.objectContaining({
                    name: 'Keep current value (**/*.lock)',
                    value: 'keep-current',
                }),
                expect.objectContaining({
                    name: 'Use recommended defaults (yarn.lock, package-lock.json, package.json +2 more)',
                    value: 'recommended',
                }),
                expect.objectContaining({
                    name: 'Choose common patterns (8 available)',
                    value: 'common',
                }),
                expect.objectContaining({
                    name: 'Clear patterns ((none))',
                    value: 'clear',
                }),
            ]),
        });
    });

    it('supports choosing common ignored file patterns interactively', async () => {
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('common');
        mockSelect
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current');
        mockCheckbox.mockResolvedValueOnce(['dist/**', 'coverage/**']);

        const result = await repositorySettingsWizardService.collectSettings({
            reviewEnabled: false,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'low',
            ignoredFilePatterns: [],
            baseBranchPatterns: [],
            ignoredTitlePatterns: [],
        });

        expect(result.ignoredFilePatterns).toEqual(['dist/**', 'coverage/**']);
        expect(mockCheckbox).toHaveBeenCalledTimes(1);
    });

    it('supports guided base branches and ignored title patterns', async () => {
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply');
        mockCheckbox.mockResolvedValueOnce(['main', 'develop']);
        mockInput.mockResolvedValueOnce('wip*\nchore(release)*');

        const result = await repositorySettingsWizardService.collectSettings({
            reviewEnabled: false,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'low',
            ignoredFilePatterns: ['dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: [],
        });

        expect(result.baseBranchPatterns).toEqual(['main', 'develop']);
        expect(result.ignoredTitlePatterns).toEqual([
            'wip*',
            'chore(release)*',
        ]);
        expect(mockCheckbox).toHaveBeenCalledTimes(1);
        expect(mockInput).toHaveBeenCalledTimes(1);
    });

    it('lets the user go back after opening common ignored file patterns', async () => {
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('back')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current');
        mockCheckbox.mockResolvedValueOnce(['dist/**']);
        mockInput.mockResolvedValueOnce('dist/**\ncoverage/**');

        const result = await repositorySettingsWizardService.collectSettings({
            reviewEnabled: false,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'low',
            ignoredFilePatterns: [],
            baseBranchPatterns: [],
            ignoredTitlePatterns: [],
        });

        expect(result.ignoredFilePatterns).toEqual(['dist/**', 'coverage/**']);
        expect(mockCheckbox).toHaveBeenCalledTimes(1);
        expect(mockInput).toHaveBeenCalledTimes(1);
    });

    it('lets the user go back after entering custom ignored file patterns', async () => {
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('back')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current');
        mockInput
            .mockResolvedValueOnce('dist/**')
            .mockResolvedValueOnce('dist/**\ncoverage/**');

        const result = await repositorySettingsWizardService.collectSettings({
            reviewEnabled: false,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'low',
            ignoredFilePatterns: [],
            baseBranchPatterns: [],
            ignoredTitlePatterns: [],
        });

        expect(result.ignoredFilePatterns).toEqual(['dist/**', 'coverage/**']);
        expect(mockInput).toHaveBeenCalledTimes(2);
    });

    it('lets the user go back after entering custom base branch patterns', async () => {
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('back')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('keep-current');
        mockInput
            .mockResolvedValueOnce('release/*')
            .mockResolvedValueOnce('main\nrelease/*');

        const result = await repositorySettingsWizardService.collectSettings({
            reviewEnabled: false,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'low',
            ignoredFilePatterns: [],
            baseBranchPatterns: [],
            ignoredTitlePatterns: [],
        });

        expect(result.baseBranchPatterns).toEqual(['main', 'release/*']);
        expect(mockInput).toHaveBeenCalledTimes(2);
    });
});
