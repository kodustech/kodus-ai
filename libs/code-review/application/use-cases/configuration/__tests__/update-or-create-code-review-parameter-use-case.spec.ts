import { UpdateOrCreateCodeReviewParameterUseCase } from '../update-or-create-code-review-parameter-use-case';
import * as yaml from 'js-yaml';

describe('UpdateOrCreateCodeReviewParameterUseCase', () => {
    const buildCentralizedConfigPrServiceMock = () => ({
        getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue(null),
        getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
        createMutationPullRequestIfEnabled: jest
            .fn()
            .mockResolvedValue({ mode: 'direct' }),
    });

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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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
            authorizationService as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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
                    name: 'config',
                    isSelected: true,
                    folders: expect.arrayContaining([
                        expect.objectContaining({
                            path: '/src/config',
                            name: 'config',
                        }),
                    ]),
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
            authorizationService as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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

    it('routes manual updates through centralized PR when centralized configuration is enabled', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({}),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/manual-settings',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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
        ).resolves.toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/manual-settings',
            }),
        );
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
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

    it('preserves custom messages already present in scoped centralized config file when saving general settings', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({
                customMessages: {
                    globalSettings: {
                        hideComments: true,
                        suggestionCopyPrompt: false,
                    },
                },
            }),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/1',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {
                            customMessages: {
                                startReviewMessage: {
                                    status: 'enabled',
                                    content: 'legacy',
                                },
                            },
                        },
                        repositories: [],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {
                ignorePaths: ['src/generated/**'],
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        const mutationRequest =
            centralizedConfigPrService.createMutationPullRequestIfEnabled.mock
                .calls[0][0];
        const files = mutationRequest.files({ repositoryFolder: 'global' });

        expect(files[0]?.operation).toBe('upsert');

        const parsedFile = yaml.load(files[0]?.content);
        expect(parsedFile).toEqual(
            expect.objectContaining({
                customMessages: {
                    globalSettings: {
                        hideComments: true,
                        suggestionCopyPrompt: false,
                    },
                },
            }),
        );
    });

    it('does not inject custom messages into centralized general settings mutation when scoped file has none', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/2',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {
                ignorePaths: ['src/generated/**'],
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        const mutationRequest =
            centralizedConfigPrService.createMutationPullRequestIfEnabled.mock
                .calls[0][0];
        const files = mutationRequest.files({ repositoryFolder: 'global' });

        expect(files[0]?.operation).toBe('upsert');

        const parsedFile = yaml.load(files[0]?.content) as Record<string, any>;
        expect(parsedFile.ignorePaths).toEqual(['src/generated/**']);
        expect(parsedFile.customMessages).toBeUndefined();
    });

    it('preserves existing pending centralized file changes when applying a new change in the same scope', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({
                runOnDraft: true,
            }),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/3',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {
                ignorePaths: ['src/generated/**'],
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        const mutationRequest =
            centralizedConfigPrService.createMutationPullRequestIfEnabled.mock
                .calls[0][0];
        const files = mutationRequest.files({ repositoryFolder: 'global' });
        const parsedFile = yaml.load(files[0]?.content) as Record<string, any>;

        expect(parsedFile.runOnDraft).toBe(true);
        expect(parsedFile.ignorePaths).toEqual(['src/generated/**']);
    });

    it('does not create a centralized PR mutation when scoped file content is unchanged', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({
                runOnDraft: true,
            }),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/4',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {},
                        repositories: [],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        const result = await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {
                runOnDraft: true,
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        expect(
            centralizedConfigPrService.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                message: expect.stringContaining('No centralized changes'),
            }),
        );
    });

    it('bypasses centralized PR when payload is empty for repository selection', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({
                automatedReviewActive: false,
            }),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/selection',
                pending: true,
            }),
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        const result = await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        } as any);

        expect(
            centralizedConfigPrService.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('treats dto-shaped payload with undefined fields as empty for selection', async () => {
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
                    });
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
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        const dtoShapedEmptyPayload = {
            id: undefined,
            name: undefined,
            path: undefined,
            isSelected: undefined,
            ignorePaths: undefined,
            automatedReviewActive: undefined,
            pullRequestApprovalActive: undefined,
            reviewCadence: undefined,
            runOnDraft: undefined,
            v2PromptOverrides: undefined,
            customMessages: undefined,
            suggestionControl: {
                severityLevelFilter: undefined,
            },
        };

        await expect(
            useCase.execute({
                actor: {
                    source: 'web',
                },
                configValue: dtoShapedEmptyPayload,
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                directoryPath: '/src',
                skipAuthorization: true,
            } as any),
        ).resolves.toBe(true);

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
    });

    it('removes a reverted-to-default key from existing scoped centralized file content', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrService = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue({ id: 'central-repo-1', name: 'centralized-config' }),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue({
                automatedReviewActive: false,
                isRequestChangesActive: true,
                pullRequestApprovalActive: true,
                customMessages: {
                    globalSettings: {
                        hideComments: true,
                    },
                },
            }),
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/5',
                pending: true,
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: {
                            automatedReviewActive: false,
                        },
                        repositories: [],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                ensure: jest.fn(),
            } as any,
            {
                detectAndSaveReferences: jest.fn(),
            } as any,
            {
                buildConfigKey: jest.fn().mockReturnValue('config-key'),
            } as any,
            centralizedConfigPrService as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        const result = await useCase.execute({
            actor: {
                source: 'web',
                organizationId: 'org-1',
                userId: 'user-1',
                userEmail: 'user@test.dev',
            },
            configValue: {
                automatedReviewActive: true,
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        expect(
            centralizedConfigPrService.createMutationPullRequestIfEnabled,
        ).toHaveBeenCalled();

        const mutationRequest =
            centralizedConfigPrService.createMutationPullRequestIfEnabled.mock
                .calls[0][0];
        const files = mutationRequest.files({ repositoryFolder: 'global' });
        const parsedFile = yaml.load(files[0]?.content) as Record<string, any>;

        expect(parsedFile.automatedReviewActive).toBeUndefined();
        expect(parsedFile.customMessages).toEqual({
            globalSettings: {
                hideComments: true,
            },
        });
        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/5',
            }),
        );
    });

    it('saves config to database when centralized config is disabled (new company setup)', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        // Centralized disabled: getScopedKodusConfigFileContent returns null,
        // createMutationPullRequestIfEnabled returns { mode: 'direct' }
        const centralizedConfigPrServiceMock = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue(null),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue(null),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    { id: 'repo-1', name: 'my-app', directories: [] },
                ]),
            } as any,
            { emit: jest.fn() } as any,
            { ensure: jest.fn() } as any,
            { detectAndSaveReferences: jest.fn() } as any,
            { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
            centralizedConfigPrServiceMock as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            configValue: {},
            organizationAndTeamData: {
                organizationId: 'new-org-1',
                teamId: 'new-team-1',
            },
            skipAuthorization: true,
        } as any);

        // Must persist to database, not short-circuit via centralized PR
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            expect.objectContaining({
                id: 'global',
                name: 'Global',
                isSelected: true,
            }),
            {
                organizationId: 'new-org-1',
                teamId: 'new-team-1',
            },
        );
    });

    it('saves updated config to database when centralized config is disabled (existing company)', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const centralizedConfigPrServiceMock = {
            getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue(null),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
        };

        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        id: 'global',
                        name: 'Global',
                        isSelected: true,
                        configs: { automatedReviewActive: true },
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'my-app',
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
                    { id: 'repo-1', name: 'my-app', directories: [] },
                ]),
            } as any,
            { emit: jest.fn() } as any,
            { ensure: jest.fn() } as any,
            { detectAndSaveReferences: jest.fn() } as any,
            { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
            centralizedConfigPrServiceMock as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            configValue: { automatedReviewActive: false },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            skipAuthorization: true,
        } as any);

        // Must persist the update to database
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();

        // Must NOT have gone through centralized PR flow
        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
    });

    it('stores byokModel override in the repository delta', async () => {
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
                    { id: 'repo-1', name: 'alpha', directories: [] },
                ]),
            } as any,
            { emit: jest.fn() } as any,
            { ensure: jest.fn() } as any,
            { detectAndSaveReferences: jest.fn() } as any,
            { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            configValue: { byokModel: 'gpt-5-mini' },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        } as any);

        const updatedConfig =
            createOrUpdateParametersUseCase.execute.mock.calls[0][1];
        const repository = updatedConfig.repositories.find(
            (repo: any) => repo.id === 'repo-1',
        );

        expect(repository.configs.byokModel).toBe('gpt-5-mini');
    });

    it('removes a reverted byokModel override from the repository delta', async () => {
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
                                configs: { byokModel: 'gpt-4' },
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    { id: 'repo-1', name: 'alpha', directories: [] },
                ]),
            } as any,
            { emit: jest.fn() } as any,
            { ensure: jest.fn() } as any,
            { detectAndSaveReferences: jest.fn() } as any,
            { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
            buildCentralizedConfigPrServiceMock() as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
        );

        await useCase.execute({
            actor: {
                source: 'sync',
                organizationId: 'org-1',
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            // '' is the "inherit" sentinel — saving it should drop the override.
            configValue: { byokModel: '' },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        } as any);

        const updatedConfig =
            createOrUpdateParametersUseCase.execute.mock.calls[0][1];
        const repository = updatedConfig.repositories.find(
            (repo: any) => repo.id === 'repo-1',
        );

        expect(repository.configs.byokModel).toBeUndefined();
    });
});
