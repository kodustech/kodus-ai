import { DeleteRepositoryCodeReviewParameterUseCase } from '../delete-repository-code-review-parameter.use-case';

describe('DeleteRepositoryCodeReviewParameterUseCase', () => {
    it('includes scoped Kody Rules files when creating centralized delete PR for repository config', async () => {
        const createMutationPullRequestIfEnabled = jest.fn().mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.test/pr/42',
            pending: true,
        });

        const centralizedConfigPrService = {
            createMutationPullRequestIfEnabled,
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
            sanitizeFileName: jest.fn().mockReturnValue('memory-rule'),
        };

        const useCase = new DeleteRepositoryCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-1-name',
                                isSelected: true,
                                configs: { automatedReviewActive: true },
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                find: jest.fn().mockResolvedValue([
                    {
                        rules: [
                            {
                                uuid: 'rule-1',
                                title: 'Rule with path',
                                repositoryId: 'repo-1',
                                directoryId: undefined,
                                centralizedConfig: {
                                    path: 'repo-1-name/.kody-rules/review/rule-with-path.yml',
                                },
                            },
                            {
                                uuid: 'rule-2',
                                title: 'Memory Rule',
                                repositoryId: 'repo-1',
                                directoryId: undefined,
                                type: 'memory',
                            },
                        ],
                    },
                ]),
                updateRulesStatusByFilter: jest.fn(),
            } as any,
            {
                user: {
                    organization: { uuid: 'org-1' },
                    uuid: 'user-1',
                    email: 'dev@kodus.io',
                },
            } as any,
            centralizedConfigPrService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            actor: {
                source: 'web',
                organizationId: 'org-1',
            },
        } as any);

        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/42',
            }),
        );

        const mutationRequest =
            createMutationPullRequestIfEnabled.mock.calls[0][0];

        const files = mutationRequest.files({
            repositoryFolder: 'repo-1-name',
        });

        expect(files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'repo-1-name/kodus-config.yml',
                    operation: 'delete',
                }),
                expect.objectContaining({
                    path: 'repo-1-name/.kody-rules/review/rule-with-path.yml',
                    operation: 'delete',
                }),
                expect.objectContaining({
                    path: 'repo-1-name/.kody-rules/memories/memory-rule.yml',
                    operation: 'delete',
                }),
            ]),
        );
    });

    it('deletes only selected directory rules when creating centralized delete PR for directory config', async () => {
        const createMutationPullRequestIfEnabled = jest.fn().mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.test/pr/43',
            pending: true,
        });

        const centralizedConfigPrService = {
            createMutationPullRequestIfEnabled,
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
            buildDirectoryGroupConfigPath: jest
                .fn()
                .mockImplementation(
                    (repositoryFolder: string, groupFolderName: string) =>
                        `${repositoryFolder}/${groupFolderName}/kodus-config.yml`,
                ),
            buildDirectoryGroupRulesPath: jest
                .fn()
                .mockImplementation(
                    (
                        repositoryFolder: string,
                        groupFolderName: string,
                        rulesDirectory: string,
                        fileName: string,
                    ) =>
                        `${repositoryFolder}/${groupFolderName}/.kody-rules/${rulesDirectory}/${fileName}`,
                ),
            sanitizeFileName: jest.fn().mockReturnValue('fallback-rule'),
        };

        const useCase = new DeleteRepositoryCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-1-name',
                                isSelected: true,
                                configs: { automatedReviewActive: true },
                                directories: [
                                    {
                                        id: 'dir-1',
                                        name: 'api',
                                        isSelected: true,
                                        configs: {
                                            automatedReviewActive: true,
                                        },
                                        folders: [
                                            {
                                                id: 'folder-1',
                                                name: 'api',
                                                path: 'src/api',
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                }),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                emit: jest.fn(),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                find: jest.fn().mockResolvedValue([
                    {
                        rules: [
                            {
                                uuid: 'rule-dir-1',
                                title: 'Directory rule',
                                repositoryId: 'repo-1',
                                directoryId: 'dir-1',
                            },
                            {
                                uuid: 'rule-dir-2',
                                title: 'Another directory rule',
                                repositoryId: 'repo-1',
                                directoryId: 'dir-2',
                                centralizedConfig: {
                                    path: 'repo-1-name/src/web/.kody-rules/review/another-directory-rule.yml',
                                },
                            },
                            {
                                uuid: 'rule-repo',
                                title: 'Repository rule',
                                repositoryId: 'repo-1',
                                centralizedConfig: {
                                    path: 'repo-1-name/.kody-rules/review/repository-rule.yml',
                                },
                            },
                        ],
                    },
                ]),
                updateRulesStatusByFilter: jest.fn(),
            } as any,
            {
                user: {
                    organization: { uuid: 'org-1' },
                    uuid: 'user-1',
                    email: 'dev@kodus.io',
                },
            } as any,
            centralizedConfigPrService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            actor: {
                source: 'web',
                organizationId: 'org-1',
            },
        } as any);

        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/43',
            }),
        );

        const mutationRequest =
            createMutationPullRequestIfEnabled.mock.calls[0][0];

        const files = mutationRequest.files({
            repositoryFolder: 'repo-1-name',
        });

        expect(files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'repo-1-name/src%2Fapi/kodus-config.yml',
                    operation: 'delete',
                }),
                expect.objectContaining({
                    path: 'repo-1-name/src%2Fapi/.kody-rules/review/fallback-rule.yml',
                    operation: 'delete',
                }),
            ]),
        );

        expect(files).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: expect.stringContaining('folders.yml'),
                }),
            ]),
        );

        expect(files).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'repo-1-name/src/web/.kody-rules/review/another-directory-rule.yml',
                }),
                expect.objectContaining({
                    path: 'repo-1-name/.kody-rules/review/repository-rule.yml',
                }),
            ]),
        );
    });

    it('bypasses centralized PR when deleting an empty repository scope', async () => {
        const createMutationPullRequestIfEnabled = jest.fn().mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.test/pr/44',
            pending: true,
        });

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new DeleteRepositoryCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-1-name',
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
                emit: jest.fn(),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                find: jest.fn().mockResolvedValue([]),
                updateRulesStatusByFilter: jest.fn(),
            } as any,
            {
                user: {
                    organization: { uuid: 'org-1' },
                    uuid: 'user-1',
                    email: 'dev@kodus.io',
                },
            } as any,
            {
                createMutationPullRequestIfEnabled,
                buildCentralizedPath: jest.fn(),
                sanitizeFileName: jest.fn(),
            } as any,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                actor: {
                    source: 'web',
                    organizationId: 'org-1',
                },
            } as any),
        ).resolves.toBe(true);

        expect(createMutationPullRequestIfEnabled).not.toHaveBeenCalled();
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
    });

    it('bypasses centralized PR when deleting an empty directory scope', async () => {
        const createMutationPullRequestIfEnabled = jest.fn().mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.test/pr/45',
            pending: true,
        });

        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new DeleteRepositoryCodeReviewParameterUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-1-name',
                                isSelected: true,
                                configs: {},
                                directories: [
                                    {
                                        id: 'dir-1',
                                        name: 'api',
                                        isSelected: true,
                                        configs: {},
                                        folders: [
                                            {
                                                id: 'folder-1',
                                                name: 'api',
                                                path: 'src/api',
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                emit: jest.fn(),
            } as any,
            {
                execute: jest.fn(),
            } as any,
            {
                find: jest.fn().mockResolvedValue([]),
                updateRulesStatusByFilter: jest.fn(),
            } as any,
            {
                user: {
                    organization: { uuid: 'org-1' },
                    uuid: 'user-1',
                    email: 'dev@kodus.io',
                },
            } as any,
            {
                createMutationPullRequestIfEnabled,
                buildCentralizedPath: jest.fn(),
                sanitizeFileName: jest.fn(),
            } as any,
        );

        await expect(
            useCase.execute({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                directoryId: 'dir-1',
                actor: {
                    source: 'web',
                    organizationId: 'org-1',
                },
            } as any),
        ).resolves.toBe(true);

        expect(createMutationPullRequestIfEnabled).not.toHaveBeenCalled();
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalled();
    });
});
