import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        config: {
            getAvailableRepositories: vi.fn(),
            addRepositories: vi.fn(),
        },
    },
}));

vi.mock('../../utils/config.js', () => ({
    loadConfig: vi.fn(),
}));

vi.mock('../git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn(),
        getRemoteUrl: vi.fn(),
        extractOrgRepo: vi.fn(),
    },
}));

import { api } from '../api/index.js';
import { loadConfig } from '../../utils/config.js';
import { gitService } from '../git.service.js';
import { repoConfigService } from '../repo-config.service.js';
import { CommandError } from '../../utils/command-errors.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockGitService = vi.mocked(gitService);
const mockApiConfig = vi.mocked(api.config);

describe('repoConfigService.addRepository', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_team_key',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        } as any);
        mockGitService.isGitRepository.mockResolvedValue(true);
        mockGitService.getRemoteUrl.mockResolvedValue(
            'git@github.com:kodustech/cli.git',
        );
        mockGitService.extractOrgRepo.mockResolvedValue({
            org: 'kodustech',
            repo: 'cli',
        });
        mockApiConfig.getAvailableRepositories.mockResolvedValue([
            {
                id: 'repo-1',
                name: 'cli',
                full_name: 'kodustech/cli',
                organizationName: 'kodustech',
                selected: false,
            },
        ] as any);
        mockApiConfig.addRepositories.mockResolvedValue({
            status: true,
            addedRepositoryIds: ['repo-1'],
            alreadyAddedRepositoryIds: [],
            totalSelected: 1,
        } as any);
        mockApiConfig.getSelectedRepositories?.mockResolvedValue?.([] as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('adds the current repository when "." resolves to an available repo', async () => {
        const result = await repoConfigService.addRepository('.');

        expect(mockApiConfig.getAvailableRepositories).toHaveBeenCalledWith(
            'kodus_team_key',
        );
        expect(mockApiConfig.addRepositories).toHaveBeenCalledWith(
            'kodus_team_key',
            ['repo-1'],
        );
        expect(result).toEqual({
            repositoryFullName: 'kodustech/cli',
            status: 'added',
        });
    });

    it('returns already-added when the repository is already selected', async () => {
        mockApiConfig.getAvailableRepositories.mockResolvedValue([
            {
                id: 'repo-1',
                name: 'cli',
                full_name: 'kodustech/cli',
                organizationName: 'kodustech',
                selected: true,
            },
        ] as any);

        const result = await repoConfigService.addRepository('.');

        expect(mockApiConfig.addRepositories).not.toHaveBeenCalled();
        expect(result).toEqual({
            repositoryFullName: 'kodustech/cli',
            status: 'already-added',
        });
    });

    it('fails when no team-key config exists', async () => {
        mockLoadConfig.mockResolvedValue(null);

        await expect(repoConfigService.addRepository('.')).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'AUTH_REQUIRED',
            }),
        );
    });

    it('works without persisting team metadata locally', async () => {
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_team_key',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        } as any);

        await expect(repoConfigService.addRepository('.')).resolves.toEqual({
            repositoryFullName: 'kodustech/cli',
            status: 'added',
        });
    });

    it('prefers KODUS_TEAM_KEY from the environment over the saved config', async () => {
        vi.stubEnv('KODUS_TEAM_KEY', 'kodus_env_team_key');

        await repoConfigService.addRepository('.');

        expect(mockApiConfig.getAvailableRepositories).toHaveBeenCalledWith(
            'kodus_env_team_key',
        );
        expect(mockApiConfig.addRepositories).toHaveBeenCalledWith(
            'kodus_env_team_key',
            ['repo-1'],
        );
    });

    it('fails when current directory is not a git repository', async () => {
        mockGitService.isGitRepository.mockResolvedValue(false);

        await expect(repoConfigService.addRepository('.')).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'NOT_IN_GIT_REPO',
            }),
        );
    });

    it('fails when repository is not found in Kodus available repositories', async () => {
        mockApiConfig.getAvailableRepositories.mockResolvedValue([] as any);

        await expect(repoConfigService.addRepository('.')).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });
});

describe('repoConfigService.listRepositories', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_team_key',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        } as any);
    });

    it('lists selected repositories for the current team', async () => {
        mockApiConfig.getSelectedRepositories = vi
            .fn()
            .mockResolvedValue([
                {
                    id: 'repo-1',
                    name: 'cli',
                    full_name: 'kodustech/cli',
                    organizationName: 'kodustech',
                    selected: true,
                },
            ] as any);

        const result = await repoConfigService.listRepositories();

        expect(mockApiConfig.getSelectedRepositories).toHaveBeenCalledWith(
            'kodus_team_key',
        );
        expect(result).toEqual([
            {
                id: 'repo-1',
                fullName: 'kodustech/cli',
            },
        ]);
    });
});
