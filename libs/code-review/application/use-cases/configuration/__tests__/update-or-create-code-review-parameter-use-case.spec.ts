import { UpdateOrCreateCodeReviewParameterUseCase } from '../update-or-create-code-review-parameter-use-case';

describe('UpdateOrCreateCodeReviewParameterUseCase', () => {
    it('creates global config when code review config does not exist', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue(null),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        directories: [],
                    },
                ]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {} as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await useCase.execute({
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            expect.objectContaining({
                id: 'global',
                name: 'Global',
                isSelected: true,
                repositories: [
                    expect.objectContaining({
                        id: 'repo-1',
                        name: 'alpha',
                        isSelected: false,
                    }),
                ],
            }),
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
    });

    it('creates repository settings without request.user when invoked by CLI', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const authorizationService = {
            ensure: jest.fn(),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: false,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        directories: [],
                    },
                ]),
            } as any,
            {
                registerCodeReviewConfigLog: jest.fn(),
            } as any,
            {} as any,
            authorizationService as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        const result = await useCase.execute({
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
        } as any);

        expect(authorizationService.ensure).not.toHaveBeenCalled();
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            expect.objectContaining({
                repositories: [
                    expect.objectContaining({
                        id: 'repo-1',
                        isSelected: true,
                    }),
                ],
            }),
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
        expect(result).toBe(true);
    });

    it('creates repository config when repository config does not exist yet', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: false,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        directories: [],
                    },
                ]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {} as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await useCase.execute({
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            configValue: {
                reviewCadence: {
                    type: 'manual',
                },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        } as any);

        const updatedConfig =
            createOrUpdateParametersUseCase.execute.mock.calls[0][1];
        const updatedRepository = updatedConfig.repositories.find(
            (repo: any) => repo.id === 'repo-1',
        );

        expect(updatedRepository).toBeDefined();
        expect(updatedRepository.isSelected).toBe(true);
    });

    it('creates directory config when directory config does not exist yet', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: true,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        directories: [],
                    },
                ]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {} as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await useCase.execute({
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            configValue: {
                reviewCadence: {
                    type: 'manual',
                },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            directoryPath: '/src/config',
            skipAuthorization: true,
        } as any);

        const updatedConfig =
            createOrUpdateParametersUseCase.execute.mock.calls[0][1];
        const updatedRepository = updatedConfig.repositories.find(
            (repo: any) => repo.id === 'repo-1',
        );

        expect(updatedRepository).toBeDefined();
        expect(updatedRepository.directories).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: '/src/config',
                    name: 'config',
                    isSelected: true,
                }),
            ]),
        );
    });

    it('does not crash when authorization runs without an HTTP request object', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const authorizationService = {
            ensure: jest.fn().mockResolvedValue(undefined),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: false,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        directories: [],
                    },
                ]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            undefined as any,
            authorizationService as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await expect(
            useCase.execute({
                configValue: {},
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
            } as any),
        ).resolves.toBe(true);

        expect(authorizationService.ensure).toHaveBeenCalledWith({
            user: undefined,
            action: 'create',
            resource: 'code_review_settings',
            repoIds: ['repo-1'],
        });
    });

    it('blocks manual updates when centralized configuration is enabled', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockImplementation((key: string) => {
                    if (key === 'centralized_config') {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                            },
                        });
                    }

                    return Promise.resolve({
                        configValue: {
                            id: 'global',
                            name: 'Global',
                            isSelected: true,
                            configs: {},
                            repositories: [],
                        },
                    });
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {} as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await expect(
            useCase.execute({
                actor: {
                    source: 'web',
                },
                configValue: {
                    automatedReviewActive: false,
                },
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                skipAuthorization: true,
            } as any),
        ).rejects.toThrow(
            'Code review settings are locked while centralized configuration is enabled.',
        );

        expect(createOrUpdateParametersUseCase.execute).not.toHaveBeenCalled();
    });

    it('allows sync updates when centralized configuration is enabled', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockImplementation((key: string) => {
                    if (key === 'centralized_config') {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                            },
                        });
                    }

                    return Promise.resolve({
                        configValue: {
                            id: 'global',
                            name: 'Global',
                            isSelected: true,
                            configs: {},
                            repositories: [],
                        },
                    });
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {} as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
        );

        await expect(
            useCase.execute({
                actor: {
                    source: 'sync',
                    organizationId: 'org-1',
                },
                configValue: {
                    automatedReviewActive: false,
                },
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                skipAuthorization: true,
            } as any),
        ).resolves.toBe(true);

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
    });
});
