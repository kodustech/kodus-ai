import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliExitError } from '../../utils/cli-exit.js';

vi.mock('@inquirer/prompts', () => ({
    checkbox: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    select: vi.fn(),
}));

vi.mock('open', () => ({
    default: vi.fn(),
}));

vi.mock('../../services/repo-config.service.js', () => ({
    repoConfigService: {
        addRepository: vi.fn(),
        listRepositories: vi.fn(),
    },
}));

vi.mock('../../services/repo-settings.service.js', () => ({
    repositorySettingsService: {
        getRepositorySettings: vi.fn(),
        updateRepositorySettings: vi.fn(),
    },
}));

import * as prompts from '@inquirer/prompts';
import open from 'open';
import { repoConfigService } from '../../services/repo-config.service.js';
import { repositorySettingsService } from '../../services/repo-settings.service.js';
import {
    configCommand,
    configRemoteAction,
    configRepoAction,
    configRepoAddAction,
    configRepoListAction,
    configRepoPatternAddAction,
    configRepoPatternRemoveAction,
    configRepoOpenAction,
    configRepoShowAction,
    configRepoSetupAction,
    configRepoSetAction,
} from '../config.js';

const mockRepoConfigService = vi.mocked(repoConfigService);
const mockRepositorySettingsService = vi.mocked(repositorySettingsService);
const mockCheckbox = vi.mocked(prompts.checkbox);
const mockConfirm = vi.mocked(prompts.confirm);
const mockInput = vi.mocked(prompts.input);
const mockSelect = vi.mocked(prompts.select);
const mockOpen = vi.mocked(open);

describe('config repo command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckbox.mockReset();
        mockConfirm.mockReset();
        mockInput.mockReset();
        mockSelect.mockReset();
        mockRepoConfigService.addRepository.mockReset();
        mockRepoConfigService.listRepositories.mockReset();
        mockRepositorySettingsService.getRepositorySettings.mockReset();
        mockRepositorySettingsService.updateRepositorySettings.mockReset();
        mockOpen.mockReset();
        mockOpen.mockResolvedValue(undefined as never);
        mockConfirm.mockResolvedValue(false);
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: true,
        });
        Object.defineProperty(process.stdout, 'isTTY', {
            configurable: true,
            value: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints success when the repository is added', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });
        mockConfirm.mockResolvedValue(false);

        await configRepoAction('.');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' was added to Kodus successfully.",
        );
        expect(mockConfirm).toHaveBeenCalledWith({
            message: 'Configure this repository now?',
            default: true,
        });
    });

    it('supports the explicit add subcommand', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configRepoAddAction('kodustech/cli');

        expect(mockRepoConfigService.addRepository).toHaveBeenCalledWith(
            'kodustech/cli',
        );

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' was added to Kodus successfully.",
        );
    });

    it('prints repository add result as JSON and skips setup prompts', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configRepoAction('.', { json: true });

        expect(mockConfirm).not.toHaveBeenCalled();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });
    });

    it('supports the explicit remote command', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configRemoteAction('kodustech/cli');

        expect(mockRepoConfigService.addRepository).toHaveBeenCalledWith(
            'kodustech/cli',
        );

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' was added to Kodus successfully.",
        );
    });

    it('prints already-added when the repository is already configured', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'already-added',
            repositoryFullName: 'kodustech/cli',
        });

        await configRepoAction('.');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' is already added to Kodus.",
        );
        expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('starts setup after adding a repository when the user confirms', async () => {
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );
        mockConfirm.mockResolvedValueOnce(true);
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('critical')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('apply');
        mockInput.mockResolvedValueOnce('main').mockResolvedValueOnce('wip*');

        await configRepoAction('.');

        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).toHaveBeenCalledWith('.');
        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });
    });

    it('skips the post-add prompt when prompt is disabled explicitly', async () => {
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configRepoAction('.', { prompt: false });

        expect(mockConfirm).not.toHaveBeenCalled();
        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).not.toHaveBeenCalled();
    });

    it('skips the post-add prompt in non-interactive terminals', async () => {
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: false,
        });

        await configRepoAction('.');

        expect(mockConfirm).not.toHaveBeenCalled();
        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).not.toHaveBeenCalled();
    });

    it('exits with code 1 when repo config fails', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockRejectedValue(
            new Error('Repository not found'),
        );

        await expect(configRepoAction('.')).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Repository not found');
    });

    it('prints repository settings in terminal format', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: [],
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

        await configRepoShowAction('.');

        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).toHaveBeenCalledWith('.');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Repository settings: kodustech/cli');
        expect(output).toContain('Automated review: enabled');
        expect(output).toContain('[repository overrides global]');
        expect(output).toContain('Auto approve: disabled');
        expect(output).toContain(
            'Minimum severity level: critical [global overrides default]',
        );
        expect(output).toContain(
            'Ignored file patterns: (none) [repository overrides global]',
        );
        expect(output).toContain(
            'Base branch patterns: main, release/* [global overrides default]',
        );
        expect(output).toContain('Ignored title patterns: wip* [default]');
    });

    it('prints repository settings in JSON format', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });

        await configRepoShowAction('.', { json: true });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
    });

    it('runs repository setup and applies updated settings', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'high',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main', 'release/*'],
                    ignoredTitlePatterns: ['wip*', 'draft*'],
                },
            },
        );
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('high')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('apply');
        mockCheckbox
            .mockResolvedValueOnce(['**/*.lock', 'dist/**'])
            .mockResolvedValueOnce(['main', 'release/*'])
            .mockResolvedValueOnce(['wip*', 'draft*']);

        await configRepoSetupAction('.');

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'high',
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*', 'draft*'],
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
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
        expect(output).toContain(
            'Files and titles can use glob patterns. Branches accept branch names or expressions like release/*.',
        );
        expect(output).toContain('Review repository settings: kodustech/cli');
        expect(output).toContain('+ Auto approve: disabled -> enabled');
        expect(output).toContain(
            '+ Minimum severity level: critical -> high',
        );
        expect(output).toContain(
            'Repository settings updated for kodustech/cli',
        );
    });

    it('prints structured setup result as JSON when requested', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'high',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main', 'release/*'],
                    ignoredTitlePatterns: ['wip*', 'draft*'],
                },
            },
        );
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce('high')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('common')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('apply');
        mockCheckbox
            .mockResolvedValueOnce(['**/*.lock', 'dist/**'])
            .mockResolvedValueOnce(['main', 'release/*'])
            .mockResolvedValueOnce(['wip*', 'draft*']);

        await configRepoSetupAction('.', { json: true });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            currentSettings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
            nextSettings: {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*', 'draft*'],
            },
            applied: true,
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*', 'draft*'],
            },
        });
    });

    it('does not update settings when setup is cancelled at preview', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('critical')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('cancel');

        await configRepoSetupAction('.');

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).not.toHaveBeenCalled();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Operation cancelled');
    });

    it('prints structured setup preview when JSON mode is cancelled before apply', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('critical')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('cancel');

        await configRepoSetupAction('.', { json: true });

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).not.toHaveBeenCalled();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            currentSettings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
            nextSettings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
            applied: false,
        });
    });

    it('lets the user revisit patterns before applying setup', async () => {
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['yarn.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'medium',
                    ignoredFilePatterns: ['dist/**', 'coverage/**'],
                    baseBranchPatterns: ['main', 'release/*'],
                    ignoredTitlePatterns: ['wip*', 'draft*'],
                },
            },
        );
        mockSelect
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce('medium')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('keep-current')
            .mockResolvedValueOnce('edit-patterns')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('custom')
            .mockResolvedValueOnce('apply')
            .mockResolvedValueOnce('apply');
        mockInput
            .mockResolvedValueOnce('dist/**\ncoverage/**')
            .mockResolvedValueOnce('main\nrelease/*')
            .mockResolvedValueOnce('wip*\ndraft*');

        await configRepoSetupAction('.');

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'medium',
            ignoredFilePatterns: ['dist/**', 'coverage/**'],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*', 'draft*'],
        });
    });

    it('updates a repository setting by explicit key', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configRepoSetAction(
            '.',
            'patterns.ignoreFiles',
            '**/*.lock,dist/**',
        );

        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).toHaveBeenCalledWith('.');
        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            'Repository settings updated for kodustech/cli',
        );
    });

    it('prints updated repository settings as JSON for set', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configRepoSetAction('.', 'review.autoApprove', 'true', {
            json: true,
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
    });

    it('adds a pattern entry without duplicating existing values', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configRepoPatternAddAction('.', 'ignore-files', 'dist/**');

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            'Repository settings updated for kodustech/cli',
        );
    });

    it('prints updated repository settings as JSON for pattern additions', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configRepoPatternAddAction('.', 'ignore-files', 'dist/**', {
            json: true,
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
    });

    it('removes a pattern entry from the selected pattern field', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configRepoPatternRemoveAction('.', 'base-branches', 'release/*');

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            'Repository settings updated for kodustech/cli',
        );
    });

    it('fails with a helpful message for unsupported pattern fields', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(
            configRepoPatternAddAction('.', 'severity', 'critical'),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain("Unsupported pattern field 'severity'");
        expect(output).toContain('ignore-files');
        expect(output).toContain('base-branches');
    });

    it('fails with a helpful message for unsupported setting keys', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(
            configRepoSetAction('.', 'review.unknown', 'true'),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain("Unsupported setting key 'review.unknown'");
        expect(output).toContain('review.enabled');
        expect(output).toContain('patterns.ignoreFiles');
    });

    it('opens the Kodus app and prints repository navigation instructions', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: [],
                baseBranchPatterns: [],
                ignoredTitlePatterns: [],
            },
        });

        await configRepoOpenAction('.', { section: 'suggestion-control' });

        expect(
            mockRepositorySettingsService.getRepositorySettings,
        ).toHaveBeenCalledWith('.');
        expect(mockOpen).toHaveBeenCalledWith('https://app.kodus.io');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Opening Kodus dashboard...');
        expect(output).toContain(
            'Navigate to: kodustech/cli > Suggestion Control',
        );
        expect(output).toContain('URL: https://app.kodus.io');
    });

    it('prints dashboard handoff metadata as JSON without opening the browser', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: [],
                baseBranchPatterns: [],
                ignoredTitlePatterns: [],
            },
        });

        await configRepoOpenAction('.', {
            section: 'suggestion-control',
            json: true,
        });

        expect(mockOpen).not.toHaveBeenCalled();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            appUrl: 'https://app.kodus.io',
            section: 'suggestion-control',
            sectionLabel: 'Suggestion Control',
        });
    });

    it('fails with a helpful message for unsupported open sections', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(
            configRepoOpenAction('.', { section: 'unknown-section' }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain("Unsupported section 'unknown-section'");
        expect(output).toContain('general');
        expect(output).toContain('suggestion-control');
    });

    it('prints selected repositories when listing config repos', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.listRepositories.mockResolvedValue([
            { id: 'repo-1', fullName: 'kodustech/cli' },
            { id: 'repo-2', fullName: 'kodustech/website' },
        ]);

        await configRepoListAction();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Configured repositories:');
        expect(output).toContain('kodustech/cli');
        expect(output).toContain('kodustech/website');
    });

    it('prints selected repositories as JSON when requested', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.listRepositories.mockResolvedValue([
            { id: 'repo-1', fullName: 'kodustech/cli' },
            { id: 'repo-2', fullName: 'kodustech/website' },
        ]);

        await configRepoListAction({ json: true });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual([
            { id: 'repo-1', fullName: 'kodustech/cli' },
            { id: 'repo-2', fullName: 'kodustech/website' },
        ]);
    });

    it('exposes remote config entrypoints in help', () => {
        const help = configCommand.helpInformation();
        const remoteHelp = configCommand.commands
            .find((command) => command.name() === 'remote')
            ?.helpInformation();

        expect(help).toContain('-r, --remote [repository]');
        expect(help).toContain('Add a repository to Kodus.');
        expect(help).toContain('Shortcut for: kodus');
        expect(help).toContain('config remote add [repository]');
        expect(help).toContain('remote [repository]');
        expect(help).not.toContain('repo [repository]');
        expect(remoteHelp).toContain(
            'Inspect and update the current repository settings in Kodus.',
        );
        expect(remoteHelp).toContain('Team-key auth is');
        expect(remoteHelp).toContain(
            'required for repository config commands',
        );
        expect(remoteHelp).toContain('shortcut for');
        expect(remoteHelp).toContain("'kodus config remote");
        expect(remoteHelp).toContain('add [options] [repository]');
        expect(remoteHelp).toContain("Equivalent to 'kodus config -r");
    });

    it('supports -r as a shortcut for remote config', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configCommand.parseAsync(['-r', '.'], { from: 'user' });

        expect(mockRepoConfigService.addRepository).toHaveBeenCalledWith('.');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' was added to Kodus successfully.",
        );
    });

    it('defaults --remote without value to the current repository', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configCommand.parseAsync(['--remote'], { from: 'user' });

        expect(mockRepoConfigService.addRepository).toHaveBeenCalledWith('.');

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            "Repository 'kodustech/cli' was added to Kodus successfully.",
        );
    });

    it('supports --no-prompt for remote config shortcut', async () => {
        mockRepoConfigService.addRepository.mockResolvedValue({
            status: 'added',
            repositoryFullName: 'kodustech/cli',
        });

        await configCommand.parseAsync(['--remote', '.', '--no-prompt'], {
            from: 'user',
        });

        expect(mockRepoConfigService.addRepository).toHaveBeenCalledWith('.');
        expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('supports add-ignore-file alias for pattern additions', async () => {
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock', 'dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configCommand.parseAsync(
            ['remote', 'add-ignore-file', '.', 'dist/**'],
            {
                from: 'user',
            },
        );

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock', 'dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });
    });

    it('supports remove-base-branch alias for pattern removals', async () => {
        mockRepositorySettingsService.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
        mockRepositorySettingsService.updateRepositorySettings.mockResolvedValue(
            {
                repositoryId: 'repo-1',
                repositoryFullName: 'kodustech/cli',
                settings: {
                    reviewEnabled: true,
                    autoApproveEnabled: false,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['**/*.lock'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['wip*'],
                },
            },
        );

        await configCommand.parseAsync(
            ['remote', 'remove-base-branch', '.', 'release/*'],
            {
                from: 'user',
            },
        );

        expect(
            mockRepositorySettingsService.updateRepositorySettings,
        ).toHaveBeenCalledWith('.', {
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
        });
    });
});
