import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        config: {
            getSelectedRepositories: vi.fn(),
            getTeams: vi.fn(),
            getCodeReviewParameter: vi.fn(),
            createOrUpdateCodeReviewParameter: vi.fn(),
            updateCodeReviewParameterRepositories: vi.fn(),
        },
    },
}));

vi.mock('../auth.service.js', () => ({
    authService: {
        getValidToken: vi.fn(),
    },
}));

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn(),
        getRemoteUrl: vi.fn(),
        extractOrgRepo: vi.fn(),
    },
}));

import { api } from '../api/index.js';
import { authService } from '../auth.service.js';
import { gitService } from '../git.service.js';
import { repositorySettingsService } from '../repo-settings.service.js';
import { CommandError } from '../../utils/command-errors.js';

const mockAuthService = vi.mocked(authService);
const mockGitService = vi.mocked(gitService);
const mockApiConfig = vi.mocked(api.config);

describe('repositorySettingsService.getRepositorySettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mockAuthService.getValidToken.mockResolvedValue('kodus_team_key');
        mockGitService.isGitRepository.mockResolvedValue(true);
        mockGitService.getRemoteUrl.mockResolvedValue(
            'git@github.com:kodustech/cli.git',
        );
        mockGitService.extractOrgRepo.mockResolvedValue({
            org: 'kodustech',
            repo: 'cli',
        });
        mockApiConfig.getSelectedRepositories.mockResolvedValue([
            {
                id: 'repo-1',
                name: 'cli',
                full_name: 'kodustech/cli',
                organizationName: 'kodustech',
                selected: true,
            },
        ] as any);
        mockApiConfig.getRepositorySettings = vi.fn().mockResolvedValue({
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'medium',
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*'],
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves "." to the current selected repository and returns its settings', async () => {
        const result =
            await repositorySettingsService.getRepositorySettings('.');

        expect(mockApiConfig.getSelectedRepositories).toHaveBeenCalledWith(
            'kodus_team_key',
        );
        expect(mockApiConfig.getRepositorySettings).toHaveBeenCalledWith(
            'kodus_team_key',
            'repo-1',
        );
        expect(result).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
    });

    it('accepts an explicit owner/repo target', async () => {
        await repositorySettingsService.getRepositorySettings('kodustech/cli');

        expect(mockGitService.isGitRepository).not.toHaveBeenCalled();
        expect(mockApiConfig.getRepositorySettings).toHaveBeenCalledWith(
            'kodus_team_key',
            'repo-1',
        );
    });

    it('fails when repository settings are requested with account auth', async () => {
        mockAuthService.getValidToken.mockResolvedValue('eyJ.test.token');

        await expect(
            repositorySettingsService.getRepositorySettings('.'),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'AUTH_REQUIRED',
            }),
        );
    });

    it('fails when the repository target is invalid', async () => {
        await expect(
            repositorySettingsService.getRepositorySettings('cli'),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });

    it('fails when the repository is not configured in Kodus', async () => {
        mockApiConfig.getSelectedRepositories.mockResolvedValue([] as any);

        await expect(
            repositorySettingsService.getRepositorySettings('.'),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });
});

describe('repositorySettingsService.updateRepositorySettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mockAuthService.getValidToken.mockResolvedValue('kodus_team_key');
        mockApiConfig.getSelectedRepositories.mockResolvedValue([
            {
                id: 'repo-1',
                name: 'cli',
                full_name: 'kodustech/cli',
                organizationName: 'kodustech',
                selected: true,
            },
        ] as any);
        mockApiConfig.updateRepositorySettings = vi.fn().mockResolvedValue({
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'medium',
            ignoredFilePatterns: ['dist/**'],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*'],
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('updates repository settings through the CLI repository settings endpoint', async () => {
        const result = await repositorySettingsService.updateRepositorySettings(
            'kodustech/cli',
            {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        );

        expect(mockApiConfig.updateRepositorySettings).toHaveBeenCalledWith(
            'kodus_team_key',
            'repo-1',
            {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        );
        expect(result).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            settings: {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        });
    });

    it('fails when repository settings are updated with account auth', async () => {
        mockAuthService.getValidToken.mockResolvedValue('eyJ.test.token');

        await expect(
            repositorySettingsService.updateRepositorySettings(
                'kodustech/cli',
                {
                    reviewEnabled: false,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'high',
                    ignoredFilePatterns: ['dist/**'],
                    baseBranchPatterns: ['main', 'release/*'],
                    ignoredTitlePatterns: ['draft*'],
                },
            ),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'AUTH_REQUIRED',
            }),
        );
    });

    it('returns centralized PR metadata when backend routes repository settings update through centralized config PR flow', async () => {
        mockApiConfig.updateRepositorySettings = vi.fn().mockResolvedValue({
            mode: 'centralized-pr',
            pending: true,
            message:
                'Centralized config is enabled. Code review settings change proposed through a pull request.',
            prUrl: 'https://github.com/kodustech/config-repo/pull/123',
        } as any);

        const result = await repositorySettingsService.updateRepositorySettings(
            'kodustech/cli',
            {
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['wip*'],
            },
        );

        expect(result).toEqual({
            repositoryId: 'repo-1',
            repositoryFullName: 'kodustech/cli',
            centralized: {
                mode: 'centralized-pr',
                pending: true,
                message:
                    'Centralized config is enabled. Code review settings change proposed through a pull request.',
                prUrl: 'https://github.com/kodustech/config-repo/pull/123',
            },
        });
    });
});
