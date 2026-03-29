import { Test, TestingModule } from '@nestjs/testing';
import { GenerateIssuesFromPrClosedUseCase } from './generate-issues-from-pr-closed.use-case';
import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/KodyIssuesManagement.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

// -- Fixtures: GitLab webhook payload --
const gitlabMergePayload = {
    object_attributes: {
        iid: 42,
        title: 'Fix bug in auth',
        description: 'Fixes login issue',
        source_branch: 'fix/auth',
        target_branch: 'main',
        action: 'merge',
        state: 'merged',
        url: 'https://gitlab.example.com/org/repo/-/merge_requests/42',
        draft: false,
        labels: [],
        source: { path_with_namespace: 'org/repo' },
        target: {
            path_with_namespace: 'org/repo',
            default_branch: 'main',
        },
    },
    user: { id: 101, name: 'dev-user', username: 'devuser' },
    project: {
        id: 999,
        name: 'repo',
        path: 'repo',
        path_with_namespace: 'org/repo',
        web_url: 'https://gitlab.example.com/org/repo',
    },
    repository: {
        name: 'repo',
        url: 'https://gitlab.example.com/org/repo.git',
    },
    assignees: [],
    reviewers: [],
};

// -- Fixtures: GitHub webhook payload --
const githubMergePayload = {
    action: 'closed',
    pull_request: {
        number: 55,
        title: 'Add feature X',
        body: 'Implements feature X',
        user: { id: 202, login: 'gh-user' },
        head: {
            ref: 'feat/x',
            sha: 'abc123',
            repo: { full_name: 'org/repo' },
        },
        base: {
            ref: 'main',
            repo: { full_name: 'org/repo' },
        },
        html_url: 'https://github.com/org/repo/pull/55',
        draft: false,
        merged: true,
    },
    repository: {
        id: 888,
        name: 'repo',
        full_name: 'org/repo',
        default_branch: 'main',
        language: 'TypeScript',
        html_url: 'https://github.com/org/repo',
    },
};

const mockIntegrationConfig = {
    team: {
        uuid: 'team-uuid',
        organization: { uuid: 'org-uuid' },
    },
};

const mockPrFiles = [
    {
        filename: 'src/auth.ts',
        suggestions: [
            {
                id: 'sug-1',
                relevantFile: 'src/auth.ts',
                suggestionContent: 'Add null check',
            },
        ],
    },
];

describe('GenerateIssuesFromPrClosedUseCase (cloud mode)', () => {
    let useCase: GenerateIssuesFromPrClosedUseCase;
    let kodyIssuesManagementServiceMock: any;
    let pullRequestServiceMock: any;
    let integrationConfigServiceMock: any;

    beforeEach(async () => {
        kodyIssuesManagementServiceMock = {
            processClosedPr: jest.fn().mockResolvedValue(undefined),
            clearIssuesCache: jest.fn().mockResolvedValue(undefined),
        };

        pullRequestServiceMock = {
            findByNumberAndRepositoryName: jest.fn(),
        };

        integrationConfigServiceMock = {
            findIntegrationConfigWithTeams: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GenerateIssuesFromPrClosedUseCase,
                {
                    provide: KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN,
                    useValue: kodyIssuesManagementServiceMock,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: pullRequestServiceMock,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: integrationConfigServiceMock,
                },
            ],
        }).compile();

        useCase = module.get<GenerateIssuesFromPrClosedUseCase>(
            GenerateIssuesFromPrClosedUseCase,
        );
    });

    describe('GitLab - successful issue generation', () => {
        beforeEach(() => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                { files: mockPrFiles },
            );
        });

        it('should call processClosedPr with correct params when GitLab MR is merged', async () => {
            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: 'org-uuid',
                        teamId: 'team-uuid',
                    },
                    repository: expect.objectContaining({
                        id: '999',
                        name: 'repo',
                        platform: PlatformType.GITLAB,
                    }),
                    prFiles: mockPrFiles,
                }),
            );
        });

        it('should pass the user from the webhook payload through to processClosedPr', async () => {
            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            const callArgs =
                kodyIssuesManagementServiceMock.processClosedPr.mock
                    .calls[0][0];
            expect(callArgs.pullRequest.user).toEqual(gitlabMergePayload.user);
            expect(callArgs.pullRequest.user.id).toBe(101);
        });

        it('should clear issues cache after processing', async () => {
            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.clearIssuesCache,
            ).toHaveBeenCalledWith('org-uuid');
        });

        it('should lookup integration config with repository id and platform type', async () => {
            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                integrationConfigServiceMock.findIntegrationConfigWithTeams,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.REPOSITORIES,
                '999',
                PlatformType.GITLAB,
            );
        });
    });

    describe('GitHub - successful issue generation', () => {
        beforeEach(() => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                { files: mockPrFiles },
            );
        });

        it('should call processClosedPr with correct params when GitHub PR is closed/merged', async () => {
            await useCase.execute({
                payload: githubMergePayload,
                platformType: PlatformType.GITHUB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationAndTeamData: {
                        organizationId: 'org-uuid',
                        teamId: 'team-uuid',
                    },
                    repository: expect.objectContaining({
                        id: '888',
                        name: 'repo',
                        platform: PlatformType.GITHUB,
                    }),
                    prFiles: mockPrFiles,
                }),
            );
        });

        it('should pass the user from the webhook payload through to processClosedPr', async () => {
            await useCase.execute({
                payload: githubMergePayload,
                platformType: PlatformType.GITHUB,
            });

            const callArgs =
                kodyIssuesManagementServiceMock.processClosedPr.mock
                    .calls[0][0];
            expect(callArgs.pullRequest.user).toEqual(
                githubMergePayload.pull_request.user,
            );
            expect(callArgs.pullRequest.user.id).toBe(202);
        });
    });

    describe('early exit scenarios - should NOT call processClosedPr', () => {
        it('should skip when no integration config found (organizationAndTeamData is null)', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [],
            );

            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).not.toHaveBeenCalled();
        });

        it('should skip when PR is not found in database', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                null,
            );

            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).not.toHaveBeenCalled();
        });

        it('should skip when PR has no files', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                { files: [] },
            );

            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).not.toHaveBeenCalled();
        });

        it('should skip when payload has no pull request data', async () => {
            await useCase.execute({
                payload: {},
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).not.toHaveBeenCalled();
        });

        it('should skip for unsupported platform type', async () => {
            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: 'unknown_platform',
            });

            expect(
                kodyIssuesManagementServiceMock.processClosedPr,
            ).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('should not throw when processClosedPr fails', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                { files: mockPrFiles },
            );
            kodyIssuesManagementServiceMock.processClosedPr.mockRejectedValue(
                new Error('LLM timeout'),
            );

            await expect(
                useCase.execute({
                    payload: gitlabMergePayload,
                    platformType: PlatformType.GITLAB,
                }),
            ).resolves.not.toThrow();
        });

        it('should not call clearIssuesCache when processClosedPr fails', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [mockIntegrationConfig],
            );
            pullRequestServiceMock.findByNumberAndRepositoryName.mockResolvedValue(
                { files: mockPrFiles },
            );
            kodyIssuesManagementServiceMock.processClosedPr.mockRejectedValue(
                new Error('LLM timeout'),
            );

            await useCase.execute({
                payload: gitlabMergePayload,
                platformType: PlatformType.GITLAB,
            });

            expect(
                kodyIssuesManagementServiceMock.clearIssuesCache,
            ).not.toHaveBeenCalled();
        });
    });
});
