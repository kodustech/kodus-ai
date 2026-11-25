import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { CentralizedConfigPrService } from '../centralized-config-pr.service';

describe('CentralizedConfigPrService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const centralizedRepository = {
        id: 'repo-centralized',
        name: 'centralized-repo',
    };

    const activePullRequest = {
        prUrl: 'https://example.test/pull/123',
        prNumber: 123,
        sourceBranch: 'kodus-centralized-config-global-123',
        targetBranch: 'main',
        repository: centralizedRepository,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const centralizedConfig = {
        enabled: true,
        repository: centralizedRepository,
        activePullRequest,
    };

    const buildService = (overrides?: {
        pullRequestState?: PullRequestState;
        centralizedConfigOverride?: any;
        openPullRequests?: any[];
        uploadFilesResult?: boolean;
        teamRepositoryConfigs?: any[];
    }) => {
        const resolvedCentralizedConfig =
            overrides?.centralizedConfigOverride || centralizedConfig;

        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: resolvedCentralizedConfig,
            }),
            createOrUpdateConfig: jest.fn().mockResolvedValue(undefined),
        };

        const integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            findAllOfTeamByConfigKey: jest
                .fn()
                .mockResolvedValue(overrides?.teamRepositoryConfigs ?? []),
        };

        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue(null),
            updateRule: jest.fn().mockResolvedValue(null),
        };

        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getPullRequest: jest.fn().mockResolvedValue({
                state: overrides?.pullRequestState,
            }),
            getPullRequests: jest
                .fn()
                .mockResolvedValue(overrides?.openPullRequests || []),
            uploadFiles: jest
                .fn()
                .mockResolvedValue(overrides?.uploadFilesResult ?? true),
            createPullRequestWithFiles: jest.fn(),
            getRepositoryContentFile: jest.fn().mockResolvedValue({
                data: {
                    content: Buffer.from('ignorePaths: []').toString('base64'),
                    encoding: 'base64',
                },
            }),
        };

        const centralizedConfigSyncUseCase = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                message: 'ok',
            }),
        };

        // ModuleRef mock that resolves CentralizedConfigSyncUseCase lazily.
        const moduleRef = {
            resolve: jest.fn().mockResolvedValue(centralizedConfigSyncUseCase),
        };

        const service = new CentralizedConfigPrService(
            parametersService as any,
            integrationConfigService as any,
            kodyRulesService as any,
            moduleRef as any,
            codeManagementService as any,
        );

        return {
            service,
            parametersService,
            codeManagementService,
            integrationConfigService,
        };
    };

    it('falls back to default branch when tracked active pull request is closed', async () => {
        const { service, parametersService, codeManagementService } =
            buildService({
                pullRequestState: PullRequestState.CLOSED,
            });

        await service.getScopedKodusConfigFileContent({
            organizationAndTeamData,
        });

        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: {
                    head: { ref: 'main' },
                    base: { ref: 'main' },
                },
            }),
        );

        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            'centralized_config',
            expect.objectContaining({
                activePullRequest: null,
            }),
            organizationAndTeamData,
        );
    });

    it('uses tracked source branch when tracked active pull request is open', async () => {
        const { service, parametersService, codeManagementService } =
            buildService({
                pullRequestState: PullRequestState.OPENED,
            });

        await service.getScopedKodusConfigFileContent({
            organizationAndTeamData,
        });

        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: {
                    head: {
                        ref: activePullRequest.sourceBranch,
                    },
                    base: {
                        ref: activePullRequest.sourceBranch,
                    },
                },
            }),
        );

        expect(parametersService.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('reuses a discovered open centralized pull request when active metadata is missing', async () => {
        const discoveredSourceBranch =
            'kodus-centralized-standard-delete-1775678312159';

        const { service, codeManagementService } = buildService({
            pullRequestState: PullRequestState.OPENED,
            centralizedConfigOverride: {
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: null,
            },
            openPullRequests: [
                {
                    number: 321,
                    prURL: 'https://example.test/pull/321',
                    head: { ref: discoveredSourceBranch },
                    base: { ref: 'main' },
                    created_at: '2026-01-01T00:00:00.000Z',
                },
            ],
            uploadFilesResult: true,
        });

        const result = await service.createMutationPullRequestIfEnabled({
            organizationAndTeamData,
            repositoryId: 'global',
            files: [
                {
                    path: '.kody-rules/review/sample.yml',
                    operation: 'delete',
                },
            ],
            title: 'Remove Kody Rule from global',
            description: 'Delete centralized rule file',
            commitMessage: 'remove rule via centralized config',
            sourceBranch: 'kodus-centralized-standard-delete-new',
        });

        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                reused: true,
                prUrl: 'https://example.test/pull/321',
                prNumber: 321,
            }),
        );

        expect(codeManagementService.uploadFiles).toHaveBeenCalledWith(
            expect.objectContaining({
                branchName: discoveredSourceBranch,
                baseBranch: 'main',
            }),
        );

        expect(
            codeManagementService.createPullRequestWithFiles,
        ).not.toHaveBeenCalled();
    });

    it('matches repository IDs by normalized value when clearing tracked metadata', async () => {
        const { service, parametersService } = buildService({
            centralizedConfigOverride: {
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: {
                    ...activePullRequest,
                    repository: {
                        ...activePullRequest.repository,
                        id: 123,
                    },
                },
            },
        });

        const wasCleared =
            await service.clearActivePullRequestMetadataIfMatching({
                organizationAndTeamData,
                repository: {
                    id: '123',
                    name: 'centralized-repo',
                },
                pullRequestNumber: 123,
            });

        expect(wasCleared).toBe(true);
        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            'centralized_config',
            expect.objectContaining({
                activePullRequest: null,
            }),
            organizationAndTeamData,
        );
    });

    describe('scopeToRepositoryConnection', () => {
        const configs = [
            {
                integration: { uuid: 'gh-a' },
                configValue: [{ id: 'repo-gh' }],
            },
            {
                integration: { uuid: 'gl-b' },
                configValue: [{ id: 'repo-gl' }],
            },
        ];

        it("routes a repository's change to its Git connection's centralized config", async () => {
            const { service } = buildService({
                teamRepositoryConfigs: configs,
            });

            await expect(
                service.scopeToRepositoryConnection(
                    organizationAndTeamData,
                    'repo-gl',
                ),
            ).resolves.toEqual({
                ...organizationAndTeamData,
                integrationId: 'gl-b',
            });
        });

        it('keeps a workspace-wide change, or an already named connection, as it is', async () => {
            const { service, integrationConfigService } = buildService({
                teamRepositoryConfigs: configs,
            });

            await expect(
                service.scopeToRepositoryConnection(
                    organizationAndTeamData,
                    'global',
                ),
            ).resolves.toEqual(organizationAndTeamData);
            await expect(
                service.scopeToRepositoryConnection(
                    { ...organizationAndTeamData, integrationId: 'gh-a' },
                    'repo-gl',
                ),
            ).resolves.toEqual({
                ...organizationAndTeamData,
                integrationId: 'gh-a',
            });
            expect(
                integrationConfigService.findAllOfTeamByConfigKey,
            ).not.toHaveBeenCalled();
        });

        it('opens the mutation pull request on the connection that lists the repository', async () => {
            const { service, parametersService } = buildService({
                teamRepositoryConfigs: configs,
            });

            await service
                .createMutationPullRequestIfEnabled({
                    organizationAndTeamData,
                    repositoryId: 'repo-gl',
                    files: [],
                    title: 't',
                    description: 'd',
                    commitMessage: 'c',
                } as any)
                .catch(() => undefined);

            expect(parametersService.findByKey).toHaveBeenCalledWith(
                expect.anything(),
                { ...organizationAndTeamData, integrationId: 'gl-b' },
            );
        });
    });

    describe('getCentralizedConfigWithValidatedPullRequest', () => {
        it('returns config unchanged when there is no active pull request', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.OPENED,
                    centralizedConfigOverride: {
                        enabled: true,
                        repository: centralizedRepository,
                        activePullRequest: null,
                    },
                });

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual({
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: null,
            });
            expect(codeManagementService.getPullRequest).not.toHaveBeenCalled();
            expect(
                parametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });

        it('returns config unchanged when active pull request is still open', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.OPENED,
                });

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual(centralizedConfig);
            expect(codeManagementService.getPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: activePullRequest.prNumber,
                }),
            );
            expect(
                parametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });

        it('clears active pull request when it has been merged', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.MERGED,
                });

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual({
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: null,
            });
            expect(codeManagementService.getPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: activePullRequest.prNumber,
                }),
            );
            expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
                'centralized_config',
                expect.objectContaining({
                    activePullRequest: null,
                }),
                organizationAndTeamData,
            );
        });

        it('clears active pull request when it has been closed without merging', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.CLOSED,
                });

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual({
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: null,
            });
            expect(codeManagementService.getPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: activePullRequest.prNumber,
                }),
            );
            expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
                'centralized_config',
                expect.objectContaining({
                    activePullRequest: null,
                }),
                organizationAndTeamData,
            );
        });

        it('clears active pull request when tracked repository does not match centralized repository', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.OPENED,
                    centralizedConfigOverride: {
                        enabled: true,
                        repository: centralizedRepository,
                        activePullRequest: {
                            ...activePullRequest,
                            repository: {
                                id: 'other-repo',
                                name: 'other-repo',
                            },
                        },
                    },
                });

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual({
                enabled: true,
                repository: centralizedRepository,
                activePullRequest: null,
            });
            expect(codeManagementService.getPullRequest).not.toHaveBeenCalled();
            expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
                'centralized_config',
                expect.objectContaining({
                    activePullRequest: null,
                }),
                organizationAndTeamData,
            );
        });

        it('returns config unchanged when pull request state cannot be fetched', async () => {
            const { service, parametersService, codeManagementService } =
                buildService({
                    pullRequestState: PullRequestState.OPENED,
                });

            codeManagementService.getPullRequest.mockRejectedValue(
                new Error('API failure'),
            );

            const result =
                await service.getCentralizedConfigWithValidatedPullRequest(
                    organizationAndTeamData,
                );

            expect(result).toEqual(centralizedConfig);
            expect(
                parametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });
    });
});
