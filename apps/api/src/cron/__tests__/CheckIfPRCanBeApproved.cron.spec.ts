import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ReviewCadenceType } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { CheckIfPRCanBeApprovedCronProvider } from '../CheckIfPRCanBeApproved.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

describe('CheckIfPRCanBeApprovedCronProvider', () => {
    const makeTeam = () => ({
        uuid: 'team-1',
        organization: { uuid: 'org-1' },
    });

    const makeParameter = () => ({
        team: { uuid: 'team-1' },
        configValue: {
            repositories: [
                { id: 'repo-a', name: 'Repo A' },
                { id: 'repo-b', name: 'Repo B' },
            ],
        },
    });

    const makeOpenPr = (prNumber: number, repositoryId: string) => ({
        number: prNumber,
        provider: PlatformType.GITLAB,
        repository: {
            id: repositoryId,
            name: repositoryId === 'repo-a' ? 'Repo A' : 'Repo B',
        },
        suggestions: [],
    });

    const makeCron = () => {
        const teamService = {
            findTeamsWithIntegrations: jest
                .fn()
                .mockResolvedValue([makeTeam()]),
        } as any;

        const parametersService = {
            findOne: jest.fn().mockResolvedValue(makeParameter()),
        } as any;

        const pullRequestService = {
            findPullRequestsWithDeliveredSuggestions: jest
                .fn()
                .mockResolvedValue([]),
            findPullRequestsWithoutDeliveredSuggestionsForApproval: jest
                .fn()
                .mockResolvedValue([]),
        } as any;

        const codeBaseConfigService = {
            getConfig: jest.fn().mockResolvedValue({
                pullRequestApprovalActive: true,
            }),
        } as any;

        const codeManagementService = {
            getPullRequestReviewThreads: jest.fn(),
            getPullRequestReviewComments: jest.fn().mockResolvedValue([]),
            getFilesByPullRequestId: jest.fn(),
            checkIfPullRequestShouldBeApproved: jest
                .fn()
                .mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest.fn(),
            createIssueComment: jest.fn().mockResolvedValue(undefined),
        } as any;

        const automationExecutionService = {
            findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId:
                jest.fn().mockResolvedValue([]),
            find: jest.fn().mockResolvedValue([]),
            findLatestExecutionByFilters: jest.fn().mockResolvedValue(null),
        } as any;

        const automationService = {
            find: jest.fn().mockResolvedValue([{ uuid: 'automation-1' }]),
        } as any;

        const teamAutomationService = {
            find: jest
                .fn()
                .mockResolvedValue([
                    { uuid: 'team-automation-1', team: { uuid: 'team-1' } },
                ]),
        } as any;

        const pullRequestMessagesService = {
            findOne: jest.fn().mockResolvedValue(null),
        } as any;

        const lock = {
            release: jest.fn().mockResolvedValue(undefined),
        };

        const distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lock),
        } as any;

        const cron = new CheckIfPRCanBeApprovedCronProvider(
            teamService,
            parametersService,
            pullRequestService,
            codeBaseConfigService,
            codeManagementService,
            automationExecutionService,
            automationService,
            teamAutomationService,
            pullRequestMessagesService,
            distributedLockService,
        );

        return {
            cron,
            deps: {
                teamService,
                parametersService,
                pullRequestService,
                codeBaseConfigService,
                codeManagementService,
                automationExecutionService,
                automationService,
                teamAutomationService,
                pullRequestMessagesService,
                distributedLockService,
                lock,
            },
        };
    };

    it('processes a successful PR when a different PR is in progress for the same team', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [{ repositoryId: 'repo-b', pullRequestNumber: 2 }],
        );

        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(2, 'repo-b')],
        );

        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions,
        ).toHaveBeenCalledWith('org-1', [2], expect.anything());
        expect(shouldApproveSpy).toHaveBeenCalledTimes(1);
        expect(shouldApproveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                teamAutomationId: 'team-automation-1',
                pr: expect.objectContaining({ number: 2 }),
            }),
        );
        expect(deps.lock.release).toHaveBeenCalledTimes(1);
    });

    it('skips approval when PR head has new commit since last reviewed commit', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findLatestExecutionByFilters = jest
            .fn()
            .mockResolvedValue({
                dataExecution: { lastAnalyzedCommit: 'old-sha' },
            });

        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({ head: { sha: 'new-sha' } });

        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', body: 'Resolved', isResolved: true }],
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                reviewCadence: { type: ReviewCadenceType.AUTO_PAUSE },
                configLevel: 'repository',
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('skips approval when reviewCadence exists but type is undefined', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findLatestExecutionByFilters = jest
            .fn()
            .mockResolvedValue({
                dataExecution: { lastAnalyzedCommit: 'old-sha' },
            });

        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({ head: { sha: 'new-sha' } });

        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', body: 'Resolved', isResolved: true }],
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                reviewCadence: {},
                configLevel: 'repository',
            } as any,
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('approves when PR head matches last successful reviewed commit for automatic mode', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findLatestExecutionByFilters = jest
            .fn()
            .mockResolvedValue({
                dataExecution: { lastAnalyzedCommit: 'same-sha' },
            });

        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({ head: { sha: 'same-sha' } });

        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', body: 'Resolved', isResolved: true }],
        );

        deps.automationExecutionService.find.mockResolvedValue([]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                reviewCadence: { type: ReviewCadenceType.AUTOMATIC },
                configLevel: 'repository',
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(true);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).toHaveBeenCalled();
    });

    it('approves a clean zero-comment PR after its configured label is added', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockResolvedValueOnce(PullRequestReviewState.PENDING)
            .mockResolvedValueOnce(PullRequestReviewState.APPROVED);
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: { kind: 'out-of-scope' },
                },
            },
        );
        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({
                head: { sha: 'same-sha' },
                labels: ['ready'],
                user: { login: 'alice' },
            });
        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [],
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalLabels: ['ready'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(true);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('Automatic approval'),
            }),
            PlatformType.GITLAB,
        );
    });

    it.each([
        ['head changes', { head: { sha: 'new-sha' }, labels: ['ready'] }],
        ['scope label is removed', { head: { sha: 'same-sha' }, labels: [] }],
    ])(
        'holds approval if the %s before the provider call',
        async (_, latest) => {
            const { cron, deps } = makeCron();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalDecision: { kind: 'approve' },
                    },
                },
            );
            deps.codeManagementService.getPullRequest = jest
                .fn()
                .mockResolvedValueOnce({
                    head: { sha: 'same-sha' },
                    labels: ['ready'],
                    user: { login: 'alice' },
                })
                .mockResolvedValueOnce({
                    ...latest,
                    user: { login: 'alice' },
                });

            const result = await (cron as any).shouldApprovePR({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                pr: makeOpenPr(77, 'repo-b'),
                codeReviewConfig: {
                    pullRequestApprovalActive: true,
                    approvalLabels: ['ready'],
                },
                teamAutomationId: 'team-automation-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.getPullRequest,
            ).toHaveBeenCalledTimes(2);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
        },
    );

    it('does not approve a zero-comment PR whose review was held', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getPullRequest = jest.fn();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: {
                        kind: 'hold',
                        reason: 'The review is not clean.',
                    },
                },
            },
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalLabels: ['ready'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.getPullRequest,
        ).not.toHaveBeenCalled();
    });

    it('holds cron approval when the saved risk assessment is stale', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalRisk: {
                        level: 'low',
                        reason: 'Looks safe.',
                        reviewedHeadSha: 'old-sha',
                    },
                },
            },
        );
        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({
                head: { sha: 'same-sha' },
                user: { login: 'alice' },
            });

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalRiskActive: true,
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('rechecks sensitive paths against live files before cron approval', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: { lastAnalyzedCommit: 'same-sha' },
            },
        );
        deps.codeManagementService.getPullRequest = jest
            .fn()
            .mockResolvedValue({
                head: { sha: 'same-sha' },
                user: { login: 'alice' },
            });
        deps.codeManagementService.getFilesByPullRequestId = jest
            .fn()
            .mockResolvedValue([{ filename: 'src/auth/login.ts' }]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalSensitivePaths: ['src/auth/**'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('does not process a PR when the same repository+PR has in-progress execution', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [],
        );

        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions,
        ).not.toHaveBeenCalled();
        expect(shouldApproveSpy).not.toHaveBeenCalled();
        expect(deps.lock.release).toHaveBeenCalledTimes(1);
    });

    it('does not suppress successful execution when PR number matches but repository differs', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [{ repositoryId: 'repo-b', pullRequestNumber: 123 }],
        );

        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(123, 'repo-b')],
        );

        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions,
        ).toHaveBeenCalledWith('org-1', [123], expect.anything());
        expect(shouldApproveSpy).toHaveBeenCalledTimes(1);
        expect(shouldApproveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                pr: expect.objectContaining({
                    number: 123,
                    repository: expect.objectContaining({ id: 'repo-b' }),
                }),
            }),
        );
    });

    it('final check blocks approval when an in-progress execution exists for the same team/repo/PR', async () => {
        const { cron, deps } = makeCron();

        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', body: 'Looks good', isResolved: true }],
        );

        deps.automationExecutionService.find.mockResolvedValue([
            { uuid: 'exec-1' },
        ]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                configLevel: 'repository',
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(deps.automationExecutionService.find).toHaveBeenCalledWith({
            teamAutomation: { uuid: 'team-automation-1' },
            pullRequestNumber: 77,
            repositoryId: 'repo-b',
            status: AutomationStatus.IN_PROGRESS,
        });
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });
    // getConfig depends only on the repository here, yet ran once per open PR —
    // every 2 minutes, each call re-reading kodus-config.yml from the provider
    // (10k Bitbucket 404s + 429s/day from one org with 3 repos).
    it('resolves the repository config once per repository, not once per PR', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [
                { repositoryId: 'repo-a', pullRequestNumber: 1 },
                { repositoryId: 'repo-a', pullRequestNumber: 2 },
                { repositoryId: 'repo-a', pullRequestNumber: 3 },
                { repositoryId: 'repo-b', pullRequestNumber: 4 },
            ],
        );
        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [
                makeOpenPr(1, 'repo-a'),
                makeOpenPr(2, 'repo-a'),
                makeOpenPr(3, 'repo-a'),
                makeOpenPr(4, 'repo-b'),
            ],
        );
        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(deps.codeBaseConfigService.getConfig).toHaveBeenCalledTimes(2);
        expect(shouldApproveSpy).toHaveBeenCalledTimes(4);
        for (const [args] of shouldApproveSpy.mock.calls as any[]) {
            expect(args.codeReviewConfig).toEqual({
                pullRequestApprovalActive: true,
            });
        }
    });

    it('discovers zero-suggestion PRs when approval labels come from kodus-config.yml', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [{ repositoryId: 'repo-a', pullRequestNumber: 7 }],
        );
        deps.pullRequestService.findPullRequestsWithoutDeliveredSuggestionsForApproval.mockResolvedValue(
            [makeOpenPr(7, 'repo-a')],
        );
        deps.codeBaseConfigService.getConfig.mockResolvedValue({
            pullRequestApprovalActive: true,
            approvalLabels: ['ready'],
        });
        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(
            deps.pullRequestService
                .findPullRequestsWithoutDeliveredSuggestionsForApproval,
        ).toHaveBeenCalled();
        expect(shouldApproveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                codeReviewConfig: expect.objectContaining({
                    approvalLabels: ['ready'],
                }),
            }),
        );
    });

    it('resolves directory policy from each PR complete file list', async () => {
        const { cron, deps } = makeCron();
        deps.parametersService.findOne.mockResolvedValue({
            team: { uuid: 'team-1' },
            configValue: {
                repositories: [
                    {
                        id: 'repo-a',
                        name: 'Repo A',
                        directories: [{ path: 'src/auth', configs: {} }],
                    },
                ],
            },
        });
        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [
                { repositoryId: 'repo-a', pullRequestNumber: 1 },
                { repositoryId: 'repo-a', pullRequestNumber: 2 },
            ],
        );
        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(1, 'repo-a'), makeOpenPr(2, 'repo-a')],
        );
        deps.codeManagementService.getFilesByPullRequestId.mockImplementation(
            async ({ prNumber }) => [
                { filename: `src/auth/file-${prNumber}.ts` },
            ],
        );
        jest.spyOn(cron as any, 'shouldApprovePR').mockResolvedValue(false);

        await cron.handleCron();

        expect(deps.codeBaseConfigService.getConfig).toHaveBeenCalledTimes(2);
        expect(deps.codeBaseConfigService.getConfig).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ id: 'repo-a' }),
            [{ filename: 'src/auth/file-1.ts' }],
        );
        expect(deps.codeBaseConfigService.getConfig).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ id: 'repo-a' }),
            [{ filename: 'src/auth/file-2.ts' }],
        );
    });

    it("approves none of a repository's PRs when its config turns approval off", async () => {
        const { cron, deps } = makeCron();

        deps.codeBaseConfigService.getConfig.mockResolvedValue({
            pullRequestApprovalActive: false,
        });
        deps.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [
                { repositoryId: 'repo-a', pullRequestNumber: 1 },
                { repositoryId: 'repo-a', pullRequestNumber: 2 },
            ],
        );
        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(1, 'repo-a'), makeOpenPr(2, 'repo-a')],
        );
        const shouldApproveSpy = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(deps.codeBaseConfigService.getConfig).toHaveBeenCalledTimes(1);
        expect(shouldApproveSpy).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });
});
