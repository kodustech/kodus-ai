import { Test, TestingModule } from '@nestjs/testing';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

describe('SavePullRequestUseCase', () => {
    let useCase: SavePullRequestUseCase;
    let mockIntegrationConfigService: any;
    let mockPullRequestsService: any;
    let mockPullRequestsRepository: any;
    let mockCodeManagementService: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockRepository = {
        id: 'repo-789',
        name: 'test-repo',
        full_name: 'org/test-repo',
    };

    const mockPullRequest = {
        number: 42,
        title: 'Test PR',
        user: { id: 'user-1', login: 'testuser' },
        head: { ref: 'feature-branch', sha: 'abc123' },
        base: { ref: 'main' },
    };

    // API format (what getFilesByPullRequestId returns)
    const mockApiFiles = [
        { filename: 'file1.ts', additions: 10, deletions: 5 },
        { filename: 'file2.ts', additions: 20, deletions: 10 },
    ];

    const mockApiCommits = [
        { sha: 'commit1', message: 'First commit' },
        { sha: 'commit2', message: 'Second commit' },
    ];

    // DB format (what findByNumberAndRepositoryId returns - IFile structure)
    const mockDbFiles = [
        {
            path: 'file1.ts',
            filename: 'file1.ts',
            added: 10,
            deleted: 5,
            changes: 15,
            patch: '',
            sha: '',
            status: 'modified',
            previousName: '',
            suggestions: [],
        },
        {
            path: 'file2.ts',
            filename: 'file2.ts',
            added: 20,
            deleted: 10,
            changes: 30,
            patch: '',
            sha: '',
            status: 'modified',
            previousName: '',
            suggestions: [],
        },
    ];

    const mockExistingPR = {
        uuid: 'pr-uuid-123',
        number: 42,
        files: mockDbFiles,
        commits: mockApiCommits,
        repository: mockRepository,
    };

    beforeEach(async () => {
        mockIntegrationConfigService = {
            findIntegrationConfigWithTeams: jest.fn().mockResolvedValue([
                {
                    team: {
                        uuid: mockOrganizationAndTeamData.teamId,
                        organization: {
                            uuid: mockOrganizationAndTeamData.organizationId,
                        },
                    },
                },
            ]),
        };

        mockPullRequestsService = {
            aggregateAndSaveDataStructure: jest
                .fn()
                .mockResolvedValue(mockExistingPR),
        };

        mockPullRequestsRepository = {
            findByNumberAndRepositoryId: jest.fn(),
        };

        mockCodeManagementService = {
            getFilesByPullRequestId: jest.fn().mockResolvedValue(mockApiFiles),
            getCommitsForPullRequestForCodeReview: jest
                .fn()
                .mockResolvedValue(mockApiCommits),
            resolveMrAuthorFromWebhookPayload: jest
                .fn()
                .mockResolvedValue(null),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SavePullRequestUseCase,
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestsService,
                },
                {
                    provide: PULL_REQUESTS_REPOSITORY_TOKEN,
                    useValue: mockPullRequestsRepository,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        useCase = module.get<SavePullRequestUseCase>(SavePullRequestUseCase);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('shouldFetchFilesAndCommits optimization', () => {
        describe('GitHub events', () => {
            it('should fetch from API when action is "opened"', async () => {
                const params = {
                    payload: {
                        action: 'opened',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).not.toHaveBeenCalled();
            });

            it('should fetch from API when action is "synchronize"', async () => {
                const params = {
                    payload: {
                        action: 'synchronize',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).not.toHaveBeenCalled();
            });

            it('should fetch from API when Forgejo action is "synchronized"', async () => {
                const params = {
                    payload: {
                        action: 'synchronized',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.FORGEJO,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).not.toHaveBeenCalled();
            });

            it('should fetch from API when action is "ready_for_review"', async () => {
                const params = {
                    payload: {
                        action: 'ready_for_review',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
            });

            it('should use cached data from DB when action is "closed" and PR exists', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        action: 'closed',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).toHaveBeenCalledWith(
                    mockPullRequest.number,
                    mockRepository.id.toString(),
                    mockOrganizationAndTeamData,
                );
                // Verify files are mapped from DB format to API format
                const callArgs =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0];
                const filesArg = callArgs[2];
                const commitsArg = callArgs[7];

                expect(filesArg).toHaveLength(2);
                expect(filesArg[0].filename).toBe('file1.ts');
                expect(filesArg[0].additions).toBe(10);
                expect(filesArg[0].deletions).toBe(5);
                expect(filesArg[1].filename).toBe('file2.ts');
                expect(filesArg[1].additions).toBe(20);
                expect(filesArg[1].deletions).toBe(10);

                expect(commitsArg).toEqual(mockApiCommits);
            });

            it('should use empty arrays when action is "closed" and PR does not exist in DB', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    null,
                );

                const params = {
                    payload: {
                        action: 'closed',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
                expect(
                    mockPullRequestsService.aggregateAndSaveDataStructure,
                ).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.anything(),
                    [],
                    expect.anything(),
                    expect.anything(),
                    expect.anything(),
                    expect.anything(),
                    [],
                );
            });

            it('should use cached data from DB when action is "assigned"', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        action: 'assigned',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).toHaveBeenCalled();
            });
        });

        describe('GitLab events', () => {
            const gitlabProject = {
                id: 'repo-789',
                name: 'test-repo',
                path: 'test-repo',
                path_with_namespace: 'org/test-repo',
            };

            // GitLab webhooks include both 'project' and 'repository' fields
            const gitlabRepository = {
                name: 'test-repo',
                url: 'git@gitlab.com:org/test-repo.git',
                homepage: 'https://gitlab.com/org/test-repo',
            };

            const gitlabMR = {
                iid: 42,
                title: 'Test MR',
                description: 'Test description',
                source_branch: 'feature-branch',
                target_branch: 'main',
                last_commit: { id: 'abc123' },
                source: { path_with_namespace: 'org/test-repo' },
                target: {
                    path_with_namespace: 'org/test-repo',
                    default_branch: 'main',
                },
                labels: [],
            };

            it('should fetch from API when GitLab action is "open"', async () => {
                const params = {
                    payload: {
                        object_attributes: {
                            ...gitlabMR,
                            action: 'open',
                        },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 'user-1', username: 'testuser' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
            });

            it('should fetch from API when GitLab action is "update" with new commit', async () => {
                const params = {
                    payload: {
                        object_attributes: {
                            ...gitlabMR,
                            action: 'update',
                            oldrev: 'old-sha-123',
                            last_commit: { id: 'new-sha-456' },
                        },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 'user-1', username: 'testuser' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
            });

            it('should use cached data when GitLab action is "close"', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        object_attributes: {
                            ...gitlabMR,
                            action: 'close',
                        },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 'user-1', username: 'testuser' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
                expect(
                    mockPullRequestsRepository.findByNumberAndRepositoryId,
                ).toHaveBeenCalled();
            });

            it('should use cached data when GitLab action is "merge"', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        object_attributes: {
                            ...gitlabMR,
                            action: 'merge',
                        },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 'user-1', username: 'testuser' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
            });

            it('should use cached data when GitLab action is "update" without new commit (description change)', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        object_attributes: {
                            ...gitlabMR,
                            action: 'update',
                            // No oldrev or same commit = not a new commit
                        },
                        changes: {
                            description: { previous: 'old', current: 'new' },
                        },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 'user-1', username: 'testuser' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
            });
        });

        describe('GitLab author resolution', () => {
            const gitlabProject = {
                id: 'repo-789',
                name: 'test-repo',
                path: 'test-repo',
                path_with_namespace: 'org/test-repo',
            };

            const gitlabRepository = {
                name: 'test-repo',
                url: 'git@gitlab.com:org/test-repo.git',
                homepage: 'https://gitlab.com/org/test-repo',
            };

            const gitlabMR = {
                iid: 42,
                title: 'Test MR',
                description: '',
                source_branch: 'feature',
                target_branch: 'main',
                last_commit: { id: 'sha' },
                source: { path_with_namespace: 'org/test-repo' },
                target: {
                    path_with_namespace: 'org/test-repo',
                    default_branch: 'main',
                },
                labels: [],
                author_id: 42,
            };

            it('replaces the actor user with the resolved MR author for GitLab', async () => {
                const realAuthor = {
                    id: 42,
                    username: 'real-author',
                    name: 'Real Author',
                };
                mockCodeManagementService.resolveMrAuthorFromWebhookPayload.mockResolvedValueOnce(
                    realAuthor,
                );

                const params = {
                    payload: {
                        object_attributes: { ...gitlabMR, action: 'open' },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        // payload.user is the pusher / actor — should be overridden
                        user: { id: 99, username: 'pusher' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.resolveMrAuthorFromWebhookPayload,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationAndTeamData: mockOrganizationAndTeamData,
                    }),
                    PlatformType.GITLAB,
                );

                const persistedPR =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0][0];
                expect(persistedPR.user).toEqual(realAuthor);
            });

            it('falls back to mapped user when the resolver returns null', async () => {
                mockCodeManagementService.resolveMrAuthorFromWebhookPayload.mockResolvedValueOnce(
                    null,
                );

                const params = {
                    payload: {
                        object_attributes: { ...gitlabMR, action: 'open' },
                        project: gitlabProject,
                        repository: gitlabRepository,
                        user: { id: 99, username: 'pusher' },
                    },
                    platformType: PlatformType.GITLAB,
                    event: 'Merge Request Hook',
                };

                await useCase.execute(params);

                const persistedPR =
                    mockPullRequestsService.aggregateAndSaveDataStructure.mock
                        .calls[0][0];
                // when resolver returns null, mapped user (the actor) is kept
                expect(persistedPR.user).toEqual({
                    id: 99,
                    username: 'pusher',
                });
            });

            it('does not call the resolver for non-GitLab platforms', async () => {
                const params = {
                    payload: {
                        action: 'opened',
                        pull_request: mockPullRequest,
                        repository: mockRepository,
                        sender: { id: 'user-1' },
                    },
                    platformType: PlatformType.GITHUB,
                    event: 'pull_request',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.resolveMrAuthorFromWebhookPayload,
                ).not.toHaveBeenCalled();
            });
        });

        describe('Azure DevOps events', () => {
            it('should fetch from API when Azure status is "active"', async () => {
                const params = {
                    payload: {
                        resource: {
                            status: 'active',
                            pullRequestId: 42,
                            title: 'Test PR',
                            repository: mockRepository,
                            sourceRefName: 'refs/heads/feature',
                            targetRefName: 'refs/heads/main',
                            createdBy: { id: 'user-1' },
                        },
                        resourceContainers: {
                            project: { id: 'project-1' },
                        },
                    },
                    platformType: PlatformType.AZURE_REPOS,
                    event: 'git.pullrequest.created',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).toHaveBeenCalled();
            });

            it('should use cached data when Azure status is "completed"', async () => {
                mockPullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
                    mockExistingPR,
                );

                const params = {
                    payload: {
                        resource: {
                            status: 'completed',
                            pullRequestId: 42,
                            title: 'Test PR',
                            repository: mockRepository,
                            sourceRefName: 'refs/heads/feature',
                            targetRefName: 'refs/heads/main',
                            createdBy: { id: 'user-1' },
                        },
                        resourceContainers: {
                            project: { id: 'project-1' },
                        },
                    },
                    platformType: PlatformType.AZURE_REPOS,
                    event: 'git.pullrequest.merged',
                };

                await useCase.execute(params);

                expect(
                    mockCodeManagementService.getFilesByPullRequestId,
                ).not.toHaveBeenCalled();
                expect(
                    mockCodeManagementService.getCommitsForPullRequestForCodeReview,
                ).not.toHaveBeenCalled();
            });
        });
    });

    describe('API calls optimization', () => {
        it('should make API calls in parallel when fetching from API', async () => {
            const params = {
                payload: {
                    action: 'opened',
                    pull_request: mockPullRequest,
                    repository: mockRepository,
                    sender: { id: 'user-1' },
                },
                platformType: PlatformType.GITHUB,
                event: 'pull_request',
            };

            const startTime = Date.now();

            // Make the API calls take some time
            mockCodeManagementService.getFilesByPullRequestId.mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve(mockApiFiles), 50),
                    ),
            );
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve(mockApiCommits), 50),
                    ),
            );

            await useCase.execute(params);

            const elapsed = Date.now() - startTime;

            // If running in parallel, should take ~50ms, not ~100ms
            // Using 200ms as threshold to account for CI/machine overhead
            expect(elapsed).toBeLessThan(200);
        });
    });
});
