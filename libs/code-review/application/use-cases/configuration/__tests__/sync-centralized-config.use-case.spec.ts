import { CentralizedConfigSyncUseCase } from '../centralized-config-sync.use-case';

describe('CentralizedConfigSyncUseCase', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    it('syncs global, repository and directory configs using centralized repo hierarchy', async () => {
        const parametersService = {
            findByKey: jest.fn(async (key: string) => {
                if (key === 'centralized_config') {
                    return {
                        configValue: {
                            enabled: true,
                            repository: {
                                id: 'central-repo-id',
                                name: 'kodus',
                            },
                        },
                    };
                }

                if (key === 'code_review_config') {
                    return {
                        configValue: {
                            id: 'global',
                        },
                    };
                }

                return null;
            }),
        };

        const integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                {
                    id: 'repo-1-id',
                    name: 'repo1',
                    full_name: 'acme/repo1',
                },
            ]),
        };

        const codeManagementService = {
            getRepositoryTree: jest.fn().mockResolvedValue([
                { type: 'file', path: 'kodus-config.yml' },
                { type: 'file', path: 'repo1/kodus-config.yml' },
                { type: 'file', path: 'repo1/dir1/kodus-config.yml' },
                { type: 'file', path: 'repo1/dir2/dir3/kodus-config.yml' },
            ]),
        };

        const codeBaseConfigService = {
            getKodusConfigFile: jest
                .fn()
                .mockImplementation(async ({ directoryPath }) => ({
                    marker: directoryPath || 'global',
                })),
        };

        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const deleteRepositoryCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            parametersService as any,
            integrationConfigService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            deleteRepositoryCodeReviewParameterUseCase as any,
            createOrUpdateParametersUseCase as any,
            codeBaseConfigService as any,
        );

        await useCase.execute({ organizationAndTeamData } as any);

        expect(codeBaseConfigService.getKodusConfigFile).toHaveBeenCalledTimes(
            4,
        );
        expect(
            codeBaseConfigService.getKodusConfigFile,
        ).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                directoryPath: undefined,
                defaultBranch: 'main',
            }),
        );
        expect(
            codeBaseConfigService.getKodusConfigFile,
        ).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                directoryPath: 'repo1',
            }),
        );
        expect(
            codeBaseConfigService.getKodusConfigFile,
        ).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                directoryPath: 'repo1/dir1',
            }),
        );
        expect(
            codeBaseConfigService.getKodusConfigFile,
        ).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({
                directoryPath: 'repo1/dir2/dir3',
            }),
        );

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                repositoryId: undefined,
                directoryPath: undefined,
                configValue: { marker: 'global' },
            }),
        );

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                repositoryId: 'repo-1-id',
                directoryPath: undefined,
                configValue: { marker: 'repo1' },
            }),
        );

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                repositoryId: 'repo-1-id',
                directoryPath: '/dir1',
                configValue: { marker: 'repo1/dir1' },
            }),
        );

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({
                repositoryId: 'repo-1-id',
                directoryPath: '/dir2/dir3',
                configValue: { marker: 'repo1/dir2/dir3' },
            }),
        );
    });

    it('creates global config baseline when missing and centralized repo has no root config file', async () => {
        const parametersService = {
            findByKey: jest.fn(async (key: string) => {
                if (key === 'centralized_config') {
                    return {
                        configValue: {
                            enabled: true,
                            repository: {
                                id: 'central-repo-id',
                                name: 'kodus',
                            },
                        },
                    };
                }

                if (key === 'code_review_config') {
                    return null;
                }

                return null;
            }),
        };

        const integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                {
                    id: 'repo-1-id',
                    name: 'repo1',
                    full_name: 'acme/repo1',
                },
            ]),
        };

        const codeManagementService = {
            getRepositoryTree: jest
                .fn()
                .mockResolvedValue([
                    { type: 'file', path: 'repo1/kodus-config.yml' },
                ]),
        };

        const codeBaseConfigService = {
            getKodusConfigFile: jest.fn().mockResolvedValue({ any: true }),
        };

        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const deleteRepositoryCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            parametersService as any,
            integrationConfigService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            deleteRepositoryCodeReviewParameterUseCase as any,
            createOrUpdateParametersUseCase as any,
            codeBaseConfigService as any,
        );

        await useCase.execute({ organizationAndTeamData } as any);

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                repositoryId: 'global',
                configValue: {},
            }),
        );

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                repositoryId: 'repo-1-id',
                directoryPath: undefined,
                configValue: { any: true },
            }),
        );
    });

    it('skips sync when configured centralized repository is not named kodus', async () => {
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    enabled: true,
                    repository: {
                        id: 'central-repo-id',
                        name: 'another-repo',
                    },
                },
            }),
        };

        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            parametersService as any,
            {
                findIntegrationConfigFormatted: jest.fn(),
            } as any,
            {
                getRepositoryTree: jest.fn(),
            } as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            {
                execute: jest.fn(),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                getKodusConfigFile: jest.fn(),
            } as any,
        );

        await useCase.execute({ organizationAndTeamData } as any);

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).not.toHaveBeenCalled();
    });

    it('removes stale directory and global configs while keeping repository config when repo file still exists', async () => {
        const parametersService = {
            findByKey: jest.fn(async (key: string) => {
                if (key === 'centralized_config') {
                    return {
                        configValue: {
                            enabled: true,
                            repository: {
                                id: 'central-repo-id',
                                name: 'kodus',
                            },
                        },
                    };
                }

                if (key === 'code_review_config') {
                    return {
                        configValue: {
                            id: 'global',
                            name: 'Global',
                            isSelected: true,
                            configs: {
                                automatedReviewActive: true,
                            },
                            repositories: [
                                {
                                    id: 'repo-1-id',
                                    name: 'repo1',
                                    isSelected: true,
                                    configs: {
                                        automatedReviewActive: true,
                                    },
                                    directories: [
                                        {
                                            id: 'dir-1',
                                            name: 'dir1',
                                            path: '/dir1',
                                            isSelected: true,
                                            configs: {
                                                automatedReviewActive: false,
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    };
                }

                return null;
            }),
        };

        const integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                {
                    id: 'repo-1-id',
                    name: 'repo1',
                    full_name: 'acme/repo1',
                },
            ]),
        };

        const codeManagementService = {
            getRepositoryTree: jest
                .fn()
                .mockResolvedValue([
                    { type: 'file', path: 'repo1/kodus-config.yml' },
                ]),
        };

        const codeBaseConfigService = {
            getKodusConfigFile: jest
                .fn()
                .mockResolvedValue({ automatedReviewActive: false }),
        };

        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const deleteRepositoryCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            parametersService as any,
            integrationConfigService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            deleteRepositoryCodeReviewParameterUseCase as any,
            createOrUpdateParametersUseCase as any,
            codeBaseConfigService as any,
        );

        await useCase.execute({ organizationAndTeamData } as any);

        expect(
            deleteRepositoryCodeReviewParameterUseCase.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryId: 'repo-1-id',
                directoryId: 'dir-1',
                teamId: 'team-1',
            }),
        );

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            expect.objectContaining({
                configs: {},
                repositories: [
                    expect.objectContaining({
                        id: 'repo-1-id',
                        configs: expect.any(Object),
                    }),
                ],
            }),
            organizationAndTeamData,
        );
    });

    it('when stale repository still has directories, only clears repository configs and does not trigger repository-removal side effects', async () => {
        const parametersService = {
            findByKey: jest.fn(async (key: string) => {
                if (key === 'centralized_config') {
                    return {
                        configValue: {
                            enabled: true,
                            repository: {
                                id: 'central-repo-id',
                                name: 'kodus',
                            },
                        },
                    };
                }

                if (key === 'code_review_config') {
                    return {
                        configValue: {
                            id: 'global',
                            name: 'Global',
                            isSelected: true,
                            configs: {
                                automatedReviewActive: true,
                            },
                            repositories: [
                                {
                                    id: 'repo-1-id',
                                    name: 'repo1',
                                    isSelected: true,
                                    configs: {
                                        automatedReviewActive: true,
                                    },
                                    directories: [
                                        {
                                            id: 'dir-1',
                                            name: 'dir1',
                                            path: '/dir1',
                                            isSelected: true,
                                            configs: {
                                                automatedReviewActive: false,
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    };
                }

                return null;
            }),
        };

        const integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                {
                    id: 'repo-1-id',
                    name: 'repo1',
                    full_name: 'acme/repo1',
                },
            ]),
        };

        const codeManagementService = {
            getRepositoryTree: jest
                .fn()
                .mockResolvedValue([
                    { type: 'file', path: 'repo1/dir1/kodus-config.yml' },
                ]),
        };

        const codeBaseConfigService = {
            getKodusConfigFile: jest
                .fn()
                .mockResolvedValue({ automatedReviewActive: false }),
        };

        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const deleteRepositoryCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            parametersService as any,
            integrationConfigService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            deleteRepositoryCodeReviewParameterUseCase as any,
            createOrUpdateParametersUseCase as any,
            codeBaseConfigService as any,
        );

        await useCase.execute({ organizationAndTeamData } as any);

        expect(
            deleteRepositoryCodeReviewParameterUseCase.execute,
        ).toHaveBeenCalledTimes(0);

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            expect.objectContaining({
                repositories: [
                    expect.objectContaining({
                        id: 'repo-1-id',
                        configs: {},
                        isSelected: true,
                    }),
                ],
            }),
            organizationAndTeamData,
        );
    });
});
