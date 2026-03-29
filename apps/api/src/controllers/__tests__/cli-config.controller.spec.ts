import {
    BadRequestException,
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';
import { CliConfigController } from '../cli/cli-config.controller';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';

describe('CliConfigController', () => {
    let controller: CliConfigController;
    let teamCliKeyService: { validateKey: jest.Mock };
    let codeManagementService: {
        getRepositories: jest.Mock;
        getTypeIntegration: jest.Mock;
    };
    let integrationConfigService: { findIntegrationConfigFormatted: jest.Mock };
    let createRepositoriesUseCase: { execute: jest.Mock };
    let updateCodeReviewParameterRepositoriesUseCase: { execute: jest.Mock };
    let updateOrCreateCodeReviewParameterUseCase: { execute: jest.Mock };
    let getCliRepositorySettingsUseCase: { execute: jest.Mock };
    let updateCliRepositorySettingsUseCase: { execute: jest.Mock };

    const teamData = {
        team: { uuid: 'team-1', name: 'Core Team' },
        organization: { uuid: 'org-1', name: 'Kodus' },
        config: {
            capabilities: [TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE],
        },
    };

    const availableRepositories = [
        {
            id: 'repo-1',
            name: 'alpha',
            organizationName: 'kodus',
            full_name: 'kodus/alpha',
            http_url: 'https://github.com/kodus/alpha',
            default_branch: 'main',
            language: 'TypeScript',
            visibility: 'private',
            avatar_url: '',
            selected: true,
        },
        {
            id: 'repo-2',
            name: 'beta',
            organizationName: 'kodus',
            full_name: 'kodus/beta',
            http_url: 'https://github.com/kodus/beta',
            default_branch: 'main',
            language: 'TypeScript',
            visibility: 'private',
            avatar_url: '',
            selected: false,
        },
        {
            id: 'repo-3',
            name: 'gamma',
            organizationName: 'kodus',
            full_name: 'kodus/gamma',
            http_url: 'https://github.com/kodus/gamma',
            default_branch: 'main',
            language: 'TypeScript',
            visibility: 'private',
            avatar_url: '',
            selected: false,
        },
    ];

    const selectedRepositories = [availableRepositories[0]];

    beforeEach(() => {
        teamCliKeyService = {
            validateKey: jest.fn().mockResolvedValue(teamData),
        };

        codeManagementService = {
            getTypeIntegration: jest.fn().mockResolvedValue('github'),
            getRepositories: jest.fn().mockResolvedValue(availableRepositories),
        } as any;

        integrationConfigService = {
            findIntegrationConfigFormatted: jest
                .fn()
                .mockResolvedValue(selectedRepositories),
        };

        createRepositoriesUseCase = {
            execute: jest.fn().mockResolvedValue({ status: true }),
        };

        updateCodeReviewParameterRepositoriesUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        getCliRepositorySettingsUseCase = {
            execute: jest.fn().mockResolvedValue({
                reviewEnabled: true,
                autoApproveEnabled: false,
                requestChangesMinSeverity: 'critical',
                ignoredFilePatterns: ['**/*.lock'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['wip*'],
                sources: {
                    reviewEnabled: {
                        level: 'repository',
                        overriddenLevel: 'global',
                    },
                },
            }),
        };

        updateCliRepositorySettingsUseCase = {
            execute: jest.fn().mockResolvedValue({
                reviewEnabled: false,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['draft*'],
            }),
        };

        controller = new CliConfigController(
            teamCliKeyService as any,
            codeManagementService as any,
            integrationConfigService as any,
            createRepositoriesUseCase as any,
            updateCodeReviewParameterRepositoriesUseCase as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            getCliRepositorySettingsUseCase as any,
            updateCliRepositorySettingsUseCase as any,
        );
    });

    it('lists available repositories using a team key', async () => {
        const result = await controller.getAvailableRepositories(
            'kodus_test_key',
            undefined,
        );

        expect(teamCliKeyService.validateKey).toHaveBeenCalledWith(
            'kodus_test_key',
        );
        expect(codeManagementService.getRepositories).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(result).toEqual(availableRepositories);
    });

    it('lists selected repositories using a bearer team key', async () => {
        const result = await controller.getSelectedRepositories(
            undefined,
            'Bearer kodus_bearer_key',
        );

        expect(teamCliKeyService.validateKey).toHaveBeenCalledWith(
            'kodus_bearer_key',
        );
        expect(
            integrationConfigService.findIntegrationConfigFormatted,
        ).toHaveBeenCalledWith('repositories', {
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        expect(result).toEqual(selectedRepositories);
    });

    it('appends requested repositories and recalculates code review repositories', async () => {
        const result = await controller.addRepositories(
            {
                repositoryIds: ['repo-2', 'repo-3'],
            },
            'kodus_test_key',
            undefined,
        );

        expect(createRepositoriesUseCase.execute).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositories: [
                availableRepositories[0],
                { ...availableRepositories[1], selected: true },
                { ...availableRepositories[2], selected: true },
            ],
            teamId: 'team-1',
            type: 'replace',
        });
        expect(
            updateCodeReviewParameterRepositoriesUseCase.execute,
        ).toHaveBeenCalledWith({
            actor: {
                organizationId: 'org-1',
                source: 'cli',
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(1, {
            actor: {
                source: 'cli',
            },
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-2',
            skipAuthorization: true,
        });
        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(2, {
            actor: {
                source: 'cli',
            },
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-3',
            skipAuthorization: true,
        });
        expect(result).toEqual({
            status: true,
            addedRepositoryIds: ['repo-2', 'repo-3'],
            alreadyAddedRepositoryIds: [],
            totalSelected: 3,
        });
    });

    it('rejects an invalid team key', async () => {
        teamCliKeyService.validateKey.mockResolvedValue(null);

        await expect(
            controller.getAvailableRepositories('kodus_bad_key', undefined),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects repository configuration when the key lacks the required capability', async () => {
        teamCliKeyService.validateKey.mockResolvedValue({
            ...teamData,
            config: {
                capabilities: [],
            },
        });

        await expect(
            controller.addRepositories(
                {
                    repositoryIds: ['repo-2'],
                },
                'kodus_test_key',
                undefined,
            ),
        ).rejects.toThrow(ForbiddenException);

        expect(createRepositoriesUseCase.execute).not.toHaveBeenCalled();
    });

    it('rejects repository ids that do not exist in the provider list', async () => {
        await expect(
            controller.addRepositories(
                {
                    repositoryIds: ['repo-999'],
                },
                'kodus_test_key',
                undefined,
            ),
        ).rejects.toThrow(BadRequestException);

        expect(createRepositoriesUseCase.execute).not.toHaveBeenCalled();
    });

    it('returns that the repository was already added when all requested repositories are selected', async () => {
        const result = await controller.addRepositories(
            {
                repositoryIds: ['repo-1'],
            },
            'kodus_test_key',
            undefined,
        );

        expect(createRepositoriesUseCase.execute).not.toHaveBeenCalled();
        expect(
            updateCodeReviewParameterRepositoriesUseCase.execute,
        ).toHaveBeenCalledWith({
            actor: {
                organizationId: 'org-1',
                source: 'cli',
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenCalledWith({
            actor: {
                source: 'cli',
            },
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        });
        expect(result).toEqual({
            status: true,
            addedRepositoryIds: [],
            alreadyAddedRepositoryIds: ['repo-1'],
            totalSelected: 1,
            message: 'Repositories already added',
        });
    });

    it('rejects repository listing when the team has no code management integration', async () => {
        codeManagementService.getTypeIntegration.mockResolvedValue(null);

        await expect(
            controller.getAvailableRepositories('kodus_test_key', undefined),
        ).rejects.toThrow(BadRequestException);
    });

    it('returns repository settings for a selected repository', async () => {
        const result = await controller.getRepositorySettings(
            'repo-1',
            'kodus_test_key',
            undefined,
        );

        expect(getCliRepositorySettingsUseCase.execute).toHaveBeenCalledWith({
            repositoryId: 'repo-1',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(result).toEqual({
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['**/*.lock'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['wip*'],
            sources: {
                reviewEnabled: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
            },
        });
    });

    it('updates repository settings through the CLI use case', async () => {
        const result = await controller.updateRepositorySettings(
            'repo-1',
            {
                reviewEnabled: false,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main', 'release/*'],
                ignoredTitlePatterns: ['draft*'],
            },
            'kodus_test_key',
            undefined,
        );

        expect(updateCliRepositorySettingsUseCase.execute).toHaveBeenCalledWith(
            {
                repositoryId: 'repo-1',
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                settings: {
                    reviewEnabled: false,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'high',
                    ignoredFilePatterns: ['dist/**'],
                    baseBranchPatterns: ['main', 'release/*'],
                    ignoredTitlePatterns: ['draft*'],
                },
            },
        );
        expect(result.autoApproveEnabled).toBe(true);
    });
});
