import { frozenContext } from '../../../../../test/fixtures/frozen-pipeline-context';
import { RequestChangesOrApproveStage } from '@libs/code-review/pipeline/stages/finish-process-review.stage';
import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { ReviewCadenceType } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { formatApprovalReasonComment } from '@libs/code-review/infrastructure/approval/approval-reason-comment';
import { CheckIfPRCanBeApprovedCronProvider } from '../CheckIfPRCanBeApproved.cron';
import { prRiskConfigurationKey } from '@libs/code-review/domain/risk/risk-configuration';
import { approvalPrMetadataKey } from '@libs/code-review/domain/approval/approval-pr-metadata';

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
            setApprovalReasonDeliveryFailure: jest.fn().mockResolvedValue(true),
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
            approvePullRequest: jest.fn().mockResolvedValue(undefined),
            getPullRequest: jest.fn(),
            getPullRequestReviewThreads: jest.fn(),
            getPullRequestReviewComments: jest.fn().mockResolvedValue([]),
            getFilesByPullRequestId: jest.fn(),
            checkIfPullRequestShouldBeApproved: jest
                .fn()
                .mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest.fn(),
            getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
            createIssueComment: jest.fn().mockResolvedValue(undefined),
            updateIssueComment: jest.fn().mockResolvedValue(undefined),
        } as any;

        const automationExecutionService = {
            update: jest.fn().mockResolvedValue(undefined),
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
        const conditionalApprovalAccess = {
            isEnabled: jest.fn().mockResolvedValue(true),
        };
        const organizationParameters = {
            findByKey: jest.fn().mockResolvedValue(undefined),
        };
        const approvalPolicies = { evaluate: jest.fn() };

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
            conditionalApprovalAccess as any,
            organizationParameters as any,
            approvalPolicies as any,
        );

        return {
            cron,
            deps: {
                approvalPolicies,
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
                conditionalApprovalAccess,
                organizationParameters,
                lock,
            },
        };
    };

    const namedPolicyCase = () => {
        const { cron, deps } = makeCron();
        const live = {
            head: { sha: 'head' },
            base: { sha: 'base' },
            title: 'Docs',
            body: '',
            user: { login: 'alice' },
            labels: ['ready'],
        };
        const reviewed = {
            kind: 'approve',
            reason: 'Approved by policy “Docs”.',
            matchedPolicy: { id: 'docs', name: 'Docs' },
            reviewedHeadSha: 'head',
            reviewedBaseSha: 'base',
            reviewedMetadataKey: approvalPrMetadataKey(live),
        };
        const execution = {
            uuid: 'execution-1',
            status: AutomationStatus.SUCCESS,
            dataExecution: {
                approvalDecision: reviewed,
                lastAnalyzedCommit: { sha: 'head' },
                approvalReviewSummary: {
                    complete: true,
                    lineFindings: 0,
                    prFindings: 0,
                },
            },
        };
        const input = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(1, 'repo-a'),
            teamAutomationId: 'team-automation-1',
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                riskAssessmentActive: false,
                approvalPolicies: [{ id: 'docs', name: 'Docs', enabled: true }],
            },
        };
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            execution,
        );
        deps.automationExecutionService.find.mockResolvedValue([]);
        deps.codeManagementService.getPullRequest.mockResolvedValue(live);
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockResolvedValueOnce(PullRequestReviewState.PENDING)
            .mockResolvedValue(PullRequestReviewState.APPROVED);
        deps.approvalPolicies.evaluate.mockResolvedValue({
            decision: reviewed,
            eligibility: {},
        });
        return {
            cron,
            deps,
            input,
            live,
            reviewed,
            execution,
            run: () => (cron as any).shouldApprovePR(input),
        };
    };

    it('approves a new named policy on its exact reviewed head and publishes the policy name', async () => {
        const { deps, run } = namedPolicyCase();
        expect(await run()).toBe(true);
        expect(deps.approvalPolicies.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({ reviewClean: true, risk: undefined }),
        );
        expect(
            deps.codeManagementService.approvePullRequest,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ headSha: 'head' }),
            PlatformType.GITLAB,
        );
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.stringContaining('Docs') }),
            PlatformType.GITLAB,
        );
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it.each([
        AutomationStatus.PARTIAL_ERROR,
        AutomationStatus.ERROR,
        AutomationStatus.IN_PROGRESS,
    ])(
        'never exposes an older clean approval behind the latest %s execution',
        async (status) => {
            const { deps, execution, run } = namedPolicyCase();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { ...execution, status },
            );
            expect(await run()).toBe(false);
            expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.approvePullRequest,
            ).not.toHaveBeenCalled();
        },
    );

    it('preserves an approval already on the host when policies change', async () => {
        const { deps, run } = namedPolicyCase();
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockReset()
            .mockResolvedValue(PullRequestReviewState.APPROVED);
        expect(await run()).toBe(false);
        expect(
            deps.codeManagementService.getReviewStatusByPullRequest,
        ).toHaveBeenCalled();
        expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
    });

    it.each(['same', 'head', 'base'])(
        'recovers pipeline-origin reason delivery only on the confirmed snapshot: %s',
        async (snapshot) => {
            const { deps, input, reviewed, live, execution, run } =
                namedPolicyCase();
            deps.pullRequestService.setApprovalReasonDeliveryFailure.mockImplementation(
                async (_org, _repo, _number, failure) => {
                    (input.pr as any).approvalReasonDeliveryFailure = failure;
                    return true;
                },
            );
            deps.codeManagementService.createIssueComment
                .mockRejectedValueOnce(
                    new Error('Transient publication failure'),
                )
                .mockResolvedValue({ id: 42 });
            const manager = new CommentManagerService(
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                deps.codeManagementService,
                deps.pullRequestService,
            );
            const stage = new RequestChangesOrApproveStage(
                deps.codeManagementService,
                { emit: jest.fn() } as any,
                { resolve: async () => null } as any,
                manager,
            );
            const result = await stage.execute(
                frozenContext({
                    organizationAndTeamData: input.organizationAndTeamData,
                    repository: input.pr.repository,
                    pullRequest: structuredClone({
                        number: input.pr.number,
                        ...live,
                    }),
                    lineComments: [],
                    codeReviewConfig: input.codeReviewConfig,
                    approvalDecision: reviewed,
                    platformType: PlatformType.GITLAB,
                }) as any,
            );
            expect(result.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        substage: 'approval-reason-publication',
                    }),
                ]),
            );
            expect(
                deps.codeManagementService.approvePullRequest,
            ).toHaveBeenCalledTimes(1);
            // The cron must repair delivery even though the review ended partial.
            execution.status = AutomationStatus.PARTIAL_ERROR;
            if (snapshot !== 'same') live[snapshot].sha = 'new-sha';
            expect(await run()).toBe(false);
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalledTimes(snapshot === 'same' ? 2 : 1);
            expect(
                deps.codeManagementService.approvePullRequest,
            ).toHaveBeenCalledTimes(1);
            expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
            if (snapshot === 'same') {
                expect(
                    (input.pr as any).approvalReasonDeliveryFailure,
                ).toBeNull();
                expect(
                    deps.codeManagementService.createIssueComment.mock
                        .calls[1][0].body,
                ).toContain(reviewed.reason);
                await run();
                expect(
                    deps.codeManagementService.createIssueComment,
                ).toHaveBeenCalledTimes(2);
            } else {
                expect(
                    (input.pr as any).approvalReasonDeliveryFailure,
                ).toMatchObject({
                    decision: 'approve',
                    reviewedHeadSha: 'head',
                    reviewedBaseSha: 'base',
                });
            }
        },
    );

    it('retries a failed named-policy reason on the next cron pass without approving twice', async () => {
        const { deps, input, execution, run } = namedPolicyCase();
        deps.pullRequestService.setApprovalReasonDeliveryFailure.mockImplementation(
            async (_org, _repo, _number, failure) => {
                (input.pr as any).approvalReasonDeliveryFailure = failure;
                return true;
            },
        );
        deps.codeManagementService.createIssueComment
            .mockRejectedValueOnce(
                new Error('Provider temporarily unavailable'),
            )
            .mockResolvedValue({ id: 42 });
        expect(await run()).toBe(true);
        expect((input.pr as any).approvalReasonDeliveryFailure).toMatchObject({
            decision: 'approve',
            reviewedHeadSha: 'head',
            reviewedBaseSha: 'base',
        });
        // A cron approval may use a policy edited after the saved review.
        // Retry its original reason, rather than attributing another policy.
        execution.dataExecution.approvalDecision.reason =
            'A different saved review decision.';
        expect(await run()).toBe(false);
        expect(
            deps.codeManagementService.approvePullRequest,
        ).toHaveBeenCalledTimes(1);
        expect(deps.approvalPolicies.evaluate).toHaveBeenCalledTimes(1);
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledTimes(2);
        expect((input.pr as any).approvalReasonDeliveryFailure).toBeNull();
        expect(
            deps.codeManagementService.createIssueComment.mock.calls[1][0].body,
        ).toContain('Approved by policy “Docs”.');
        await run();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledTimes(2);
    });

    it.each(['head', 'base', 'unbound', 'hold'])(
        'does not attribute an existing approval to a stale or unrelated failed reason (%s)',
        async (mismatch) => {
            const { deps, input, run } = namedPolicyCase();
            const failure = {
                decision: mismatch === 'hold' ? 'hold' : 'approve',
                reason: 'Approved by policy “Docs”.',
                occurredAt: new Date().toISOString(),
                reviewedHeadSha:
                    mismatch === 'head'
                        ? 'old'
                        : mismatch === 'unbound'
                          ? undefined
                          : 'head',
                reviewedBaseSha: mismatch === 'base' ? 'old' : 'base',
            };
            (input.pr as any).approvalReasonDeliveryFailure = failure;
            deps.codeManagementService.getReviewStatusByPullRequest
                .mockReset()
                .mockResolvedValue(PullRequestReviewState.APPROVED);
            expect(await run()).toBe(false);
            if (mismatch === 'head' || mismatch === 'base')
                expect(
                    deps.codeManagementService.getPullRequest,
                ).toHaveBeenCalled();
            else
                expect(
                    deps.codeManagementService.getPullRequest,
                ).not.toHaveBeenCalled();
            expect((input.pr as any).approvalReasonDeliveryFailure).toBe(
                failure,
            );
            expect(
                deps.pullRequestService.setApprovalReasonDeliveryFailure,
            ).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.approvePullRequest,
            ).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.createIssueComment,
            ).not.toHaveBeenCalled();
        },
    );

    it('keeps a failed approval reason pending when its retry snapshot cannot be read', async () => {
        const { deps, input, reviewed, run } = namedPolicyCase();
        const failure = {
            decision: 'approve',
            reason: reviewed.reason,
            occurredAt: new Date().toISOString(),
            reviewedHeadSha: 'head',
            reviewedBaseSha: 'base',
        };
        (input.pr as any).approvalReasonDeliveryFailure = failure;
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockReset()
            .mockResolvedValue(PullRequestReviewState.APPROVED);
        deps.codeManagementService.getPullRequest.mockRejectedValue(
            new Error('Provider unavailable'),
        );
        expect(await run()).toBe(false);
        expect(deps.codeManagementService.getPullRequest).toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
        expect(
            deps.pullRequestService.setApprovalReasonDeliveryFailure,
        ).not.toHaveBeenCalled();
        expect((input.pr as any).approvalReasonDeliveryFailure).toBe(failure);
    });

    it('publishes no-match outcomes and never falls back to the old generic approval path', async () => {
        const { deps, input, run } = namedPolicyCase();
        input.codeReviewConfig.approvalPolicies = [];
        deps.approvalPolicies.evaluate.mockResolvedValue({
            decision: {
                kind: 'out-of-scope',
                reason: 'No approval policy matched. Docs: Required labels did not match.',
            },
            eligibility: {},
        });
        expect(await run()).toBe(false);
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('No approval policy matched'),
            }),
            PlatformType.GITLAB,
        );
        expect(
            deps.codeManagementService.approvePullRequest,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('holds PR-level findings that have no verified resolution', async () => {
        const { deps, execution, run } = namedPolicyCase();
        execution.dataExecution.approvalReviewSummary.prFindings = 1;
        expect(await run()).toBe(false);
        expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
    });

    it.each([false, undefined])(
        'does not approve an unresolved or missing delivered finding: %p',
        async (isResolved) => {
            const { deps, execution, input, run } = namedPolicyCase();
            execution.dataExecution.approvalReviewSummary.lineFindings = 1;
            input.pr.suggestions = [{ comment: { id: 'c-1' } }] as any;
            deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
                isResolved === undefined ? [] : [{ id: 'c-1', isResolved }],
            );
            expect(await run()).toBe(false);
            expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
        },
    );

    it('rechecks old delivered findings even when an incremental review adds none', async () => {
        const { deps, input, run } = namedPolicyCase();
        input.pr.suggestions = [{ comment: { id: 'c-1' } }] as any;
        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', isResolved: false }],
        );
        expect(await run()).toBe(false);
        expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
    });

    it('allows resolved delivered findings through the policy check', async () => {
        const { deps, input, execution, run } = namedPolicyCase();
        execution.dataExecution.approvalReviewSummary.lineFindings = 1;
        input.pr.suggestions = [{ comment: { id: 'c-1' } }] as any;
        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', isResolved: true }],
        );
        expect(await run()).toBe(true);
    });

    it('holds if an evaluation sees a fresh failed rerun before approving', async () => {
        const { deps, execution, run } = namedPolicyCase();
        deps.automationExecutionService.findLatestExecutionByFilters
            .mockResolvedValueOnce(execution)
            .mockResolvedValue({
                ...execution,
                uuid: 'execution-2',
                status: AutomationStatus.ERROR,
            });
        expect(await run()).toBe(false);
        expect(
            deps.codeManagementService.approvePullRequest,
        ).not.toHaveBeenCalled();
    });

    it.each(['head', 'base', 'labels', 'body'])(
        'holds when %s changes after the policy decision',
        async (field) => {
            const { deps, live, run } = namedPolicyCase();
            const changed = {
                ...live,
                [field]:
                    field === 'head' || field === 'base'
                        ? { sha: 'new' }
                        : field === 'labels'
                          ? []
                          : 'New description',
            };
            deps.codeManagementService.getPullRequest
                .mockResolvedValueOnce(live)
                .mockResolvedValue(changed);
            expect(await run()).toBe(false);
            expect(
                deps.codeManagementService.approvePullRequest,
            ).not.toHaveBeenCalled();
        },
    );

    it('does not approve with risk enabled and no current shared assessment', async () => {
        const { deps, input, run } = namedPolicyCase();
        input.codeReviewConfig.riskAssessmentActive = true;
        expect(await run()).toBe(false);
        expect(deps.approvalPolicies.evaluate).not.toHaveBeenCalled();
    });

    it('persists eligibility for cron reuse without mutating review evidence', async () => {
        const { deps, reviewed, execution, run } = namedPolicyCase();
        const eligibility = { key: { status: 'eligible', key: 'key' } };
        deps.approvalPolicies.evaluate.mockResolvedValue({
            decision: reviewed,
            eligibility,
        });
        expect(await run()).toBe(true);
        expect(deps.automationExecutionService.update).toHaveBeenCalledWith(
            { uuid: execution.uuid },
            {
                dataExecution: {
                    ...execution.dataExecution,
                    approvalPolicyEligibility: eligibility,
                },
            },
        );
    });

    it('does not evaluate a saved conditional policy when access is disabled', async () => {
        const { cron, deps } = makeCron();
        deps.conditionalApprovalAccess.isEnabled.mockResolvedValue(false);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalLabels: ['auto-approve'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(deps.conditionalApprovalAccess.isEnabled).toHaveBeenCalled();
        expect(
            deps.codeManagementService.getPullRequest,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

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
        expect(
            deps.pullRequestService
                .findPullRequestsWithoutDeliveredSuggestionsForApproval,
        ).not.toHaveBeenCalled();
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

    it('approves when PR head matches last successful reviewed commit for automatic mode', async () => {
        const { cron, deps } = makeCron();

        deps.automationExecutionService.findLatestExecutionByFilters = jest
            .fn()
            .mockResolvedValue({
                dataExecution: { lastAnalyzedCommit: 'same-sha' },
            });

        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 'c-1', body: 'Resolved', isResolved: true }],
        );

        deps.automationExecutionService.find.mockResolvedValue([]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 'c-1' } }],
            },
            codeReviewConfig: {
                reviewCadence: { type: ReviewCadenceType.AUTOMATIC },
                configLevel: 'repository',
            },
            teamAutomationId: 'team-automation-1',
            currentPullRequest: { head: { sha: 'same-sha' } },
        });

        expect(result).toBe(true);
        expect(
            deps.codeManagementService.getPullRequest,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).toHaveBeenCalled();
    });

    it('skips clean PRs without a label scope before provider and execution reads', async () => {
        const { cron, deps } = makeCron();

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: { pullRequestApprovalActive: true },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.automationExecutionService.findLatestExecutionByFilters,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.getPullRequest,
        ).not.toHaveBeenCalled();
    });

    it('approves a clean zero-comment PR after its configured label is added', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockResolvedValueOnce(PullRequestReviewState.NONE)
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

    it.each([false, true])(
        'revalidates the shared risk configuration before cron approval (changed=%s)',
        async (changed) => {
            const { cron, deps } = makeCron();
            deps.codeManagementService.getReviewStatusByPullRequest
                .mockResolvedValueOnce(PullRequestReviewState.NONE)
                .mockResolvedValueOnce(PullRequestReviewState.APPROVED);
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'same-sha' },
                base: { sha: 'same-base' },
                user: { login: 'alice' },
            });
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalDecision: { kind: 'approve' },
                        approvalRisk: {
                            level: 'low',
                            reviewedHeadSha: 'same-sha',
                            reason: 'No material risk.',
                        },
                        riskAssessment: {
                            status: 'assessed',
                            riskIdentified: false,
                            reason: 'No material risk.',
                            snapshot: {
                                organizationId: 'org-1',
                                repositoryId: 'repo-b',
                                prNumber: 77,
                                baseSha: 'same-base',
                                headSha: 'same-sha',
                                assessmentKey: 'key',
                                configurationKey: prRiskConfigurationKey({}),
                            },
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
                    riskAssessmentActive: true,
                    ...(changed
                        ? {
                              riskCriteria: [
                                  {
                                      id: 'access',
                                      name: 'Access',
                                      enabled: true,
                                      instructions: 'Check tenant isolation.',
                                  },
                              ],
                          }
                        : {}),
                },
                teamAutomationId: 'team-automation-1',
            });
            expect(result).toBe(!changed);
            if (changed)
                expect(
                    deps.codeManagementService
                        .checkIfPullRequestShouldBeApproved,
                ).not.toHaveBeenCalled();
            else
                expect(
                    deps.codeManagementService
                        .checkIfPullRequestShouldBeApproved,
                ).toHaveBeenCalledTimes(1);
        },
    );

    it('holds a clean zero-comment PR that changes a sensitive path without requiring labels', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: { kind: 'hold' },
                },
            },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue({
            head: { sha: 'same-sha' },
            user: { login: 'alice' },
        });
        deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue([
            { filename: 'src/qa-approval/smoke.ts' },
        ]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(77, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalSensitivePaths: ['src/qa-approval/**'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('src/qa-approval/smoke.ts'),
            }),
            PlatformType.GITLAB,
        );
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it('approves a clean zero-comment PR outside sensitive paths without requiring labels', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getReviewStatusByPullRequest
            .mockResolvedValueOnce(PullRequestReviewState.NONE)
            .mockResolvedValueOnce(PullRequestReviewState.APPROVED);
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: { kind: 'approve' },
                },
            },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue({
            head: { sha: 'same-sha' },
            user: { login: 'alice' },
        });
        deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue([
            { filename: 'src/qa-approval-clean/smoke.ts' },
        ]);

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: makeOpenPr(78, 'repo-b'),
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalSensitivePaths: ['src/qa-approval/**'],
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
                body: expect.stringContaining('Automatic approval completed'),
            }),
            PlatformType.GITLAB,
        );
    });

    it('repairs a missing reason comment for an already approved PR', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: { kind: 'approve' },
                },
            },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue({
            head: { sha: 'same-sha' },
            labels: ['ready'],
            user: { login: 'alice' },
        });
        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [],
        );
        deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
            PullRequestReviewState.APPROVED,
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
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledTimes(1);
    });

    it.each(['missing', 'existing', 'already-current'])(
        'reconciles an approved partial execution with a %s explanation',
        async (commentState) => {
            const { cron, deps } = makeCron();
            const reason = 'The reviewed change is low risk.';
            const body = formatApprovalReasonComment('approve', reason);
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    status: AutomationStatus.PARTIAL_ERROR,
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalDecision: { kind: 'approve', reason },
                        approvalRisk: {
                            level: 'low',
                            reason,
                            reviewedHeadSha: 'same-sha',
                        },
                    },
                },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'same-sha' },
            });
            deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                PullRequestReviewState.APPROVED,
            );
            if (commentState !== 'missing') {
                deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
                    [
                        {
                            id: 42,
                            body:
                                commentState === 'already-current'
                                    ? body
                                    : formatApprovalReasonComment(
                                          'hold',
                                          'Old reason.',
                                      ),
                        },
                    ],
                );
            }

            expect(
                await (cron as any).shouldApprovePR({
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
                }),
            ).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
            if (commentState === 'missing') {
                expect(
                    deps.codeManagementService.createIssueComment,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({ body }),
                    PlatformType.GITLAB,
                );
                expect(
                    deps.codeManagementService.updateIssueComment,
                ).not.toHaveBeenCalled();
            } else if (commentState === 'existing') {
                expect(
                    deps.codeManagementService.updateIssueComment,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({ body, commentId: 42 }),
                    PlatformType.GITLAB,
                );
                expect(
                    deps.codeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
            } else {
                expect(
                    deps.codeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
                expect(
                    deps.codeManagementService.updateIssueComment,
                ).not.toHaveBeenCalled();
            }
        },
    );

    it.each([PullRequestReviewState.NONE, null, 'provider-error', 'new-head'])(
        'does not replay a partial approval when host verification is %s',
        async (hostState) => {
            const { cron, deps } = makeCron();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    status: AutomationStatus.PARTIAL_ERROR,
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalDecision: {
                            kind: 'approve',
                            reason: 'Low risk.',
                        },
                        approvalRisk: {
                            level: 'low',
                            reviewedHeadSha: 'same-sha',
                        },
                    },
                },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: {
                    sha: hostState === 'new-head' ? 'new-sha' : 'same-sha',
                },
            });
            if (hostState === 'provider-error') {
                deps.codeManagementService.getReviewStatusByPullRequest.mockRejectedValue(
                    new Error('Unavailable'),
                );
            } else {
                deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                    hostState === 'new-head'
                        ? PullRequestReviewState.APPROVED
                        : hostState,
                );
            }

            expect(
                await (cron as any).shouldApprovePR({
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
                }),
            ).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
            for (const [args] of deps.codeManagementService.createIssueComment
                .mock.calls) {
                expect(args.body).not.toContain('Automatic approval completed');
            }
            if (hostState !== PullRequestReviewState.NONE) {
                expect(
                    deps.codeManagementService.createIssueComment,
                ).not.toHaveBeenCalled();
            }
        },
    );

    it('updates the existing approval reason instead of posting another comment', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
            [
                {
                    id: 42,
                    threadId: 99,
                    body: '<!-- kodus-conditional-approval -->\n**Automatic approval held:** Old reason.',
                },
            ],
        );

        await (cron as any).postConditionalApprovalReason(
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'api' },
                prNumber: 7,
            },
            PlatformType.AZURE_REPOS,
            { kind: 'hold', reason: 'Sensitive path needs a person.' },
        );

        expect(
            deps.codeManagementService.updateIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                commentId: 42,
                threadId: 99,
                body: expect.stringContaining('Sensitive path needs a person.'),
            }),
            PlatformType.AZURE_REPOS,
        );
        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
    });

    it('does not create a reason comment when the provider lookup fails', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
            null,
        );

        await (cron as any).postConditionalApprovalReason(
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'api' },
                prNumber: 7,
            },
            PlatformType.AZURE_REPOS,
            { kind: 'hold', reason: 'A person should review this.' },
        );

        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.getAllCommentsInPullRequest,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ failOnError: true }),
            PlatformType.AZURE_REPOS,
        );
        expect((cron as any).logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    operation: 'getAllCommentsInPullRequest',
                }),
            }),
        );
        expect(
            deps.pullRequestService.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledWith(
            'org-1',
            'repo-1',
            7,
            {
                decision: 'hold',
                reason: 'A person should review this.',
                occurredAt: expect.any(String),
            },
            { notAfter: expect.any(String) },
        );
    });

    it('clears a prior delivery failure when the reason is already on the PR', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
            [
                {
                    id: 42,
                    body: formatApprovalReasonComment(
                        'hold',
                        'A person should review this.',
                    ),
                },
            ],
        );

        await (cron as any).postConditionalApprovalReason(
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'api' },
                prNumber: 7,
            },
            PlatformType.GITHUB,
            { kind: 'hold', reason: 'A person should review this.' },
        );

        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.updateIssueComment,
        ).not.toHaveBeenCalled();
        expect(
            deps.pullRequestService.setApprovalReasonDeliveryFailure,
        ).toHaveBeenCalledWith('org-1', 'repo-1', 7, null, {
            notAfter: expect.any(String),
        });
    });

    it('logs a context-read failure without reading the failing getter twice', async () => {
        const { cron, deps } = makeCron();
        const contextError = new Error('context unavailable');
        const getContext = jest.fn(() => {
            throw contextError;
        });

        await (cron as any).recordApprovalReasonDelivery(
            {
                get organizationAndTeamData() {
                    return getContext();
                },
                repository: { id: 'repo-1', name: 'api' },
                prNumber: 7,
            },
            null,
        );

        expect(getContext).toHaveBeenCalledTimes(1);
        expect(
            deps.pullRequestService.setApprovalReasonDeliveryFailure,
        ).not.toHaveBeenCalled();
        expect((cron as any).logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ error: contextError }),
        );
    });

    it('uses the provider numeric note ID when its primary ID is opaque', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
            [
                {
                    id: 'opaque-id',
                    note_id: 42,
                    body: '<!-- kodus-conditional-approval -->\n**Automatic approval held:** Old reason.',
                },
            ],
        );

        await (cron as any).postConditionalApprovalReason(
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'api' },
                prNumber: 7,
            },
            PlatformType.GITHUB,
            { kind: 'hold', reason: 'Sensitive path needs a person.' },
        );

        expect(
            deps.codeManagementService.updateIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ commentId: 42 }),
            PlatformType.GITHUB,
        );
        expect(
            deps.codeManagementService.createIssueComment,
        ).not.toHaveBeenCalled();
    });

    it.each([
        { existing: true, operation: 'updateIssueComment' },
        { existing: false, operation: 'createIssueComment' },
    ])(
        'logs a $operation failure returned as null',
        async ({ existing, operation }) => {
            const { cron, deps } = makeCron();
            deps.codeManagementService.getAllCommentsInPullRequest.mockResolvedValue(
                existing
                    ? [
                          {
                              id: 42,
                              body: '<!-- kodus-conditional-approval -->\n**Automatic approval held:** Old reason.',
                          },
                      ]
                    : [],
            );
            deps.codeManagementService[operation].mockResolvedValue(null);

            await (cron as any).postConditionalApprovalReason(
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    repository: { id: 'repo-1', name: 'api' },
                    prNumber: 7,
                },
                PlatformType.GITHUB,
                { kind: 'hold', reason: 'A person should review this.' },
            );

            expect((cron as any).logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Could not post conditional approval reason',
                    metadata: expect.objectContaining({ operation }),
                }),
            );
        },
    );

    it('bounds reason-comment lookup without posting after the lookup times out', async () => {
        jest.useFakeTimers();
        try {
            const { cron, deps } = makeCron();
            deps.codeManagementService.getAllCommentsInPullRequest.mockReturnValue(
                new Promise(() => {}),
            );

            const posting = (cron as any).postConditionalApprovalReason(
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    repository: { id: 'repo-1', name: 'api' },
                    prNumber: 7,
                },
                PlatformType.GITHUB,
                { kind: 'hold', reason: 'A person should review this.' },
            );
            await jest.advanceTimersByTimeAsync(10_000);
            await posting;

            expect(
                deps.codeManagementService.createIssueComment,
            ).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.updateIssueComment,
            ).not.toHaveBeenCalled();
            expect((cron as any).logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        repositoryId: 'repo-1',
                        prNumber: 7,
                        lookupTimeoutMs: 10_000,
                    }),
                }),
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it('holds conditional approval when the provider status is unavailable', async () => {
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
            .mockResolvedValue({
                head: { sha: 'same-sha' },
                labels: ['ready'],
                user: { login: 'alice' },
            });
        deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
            null,
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
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it.each([
        ['head changes', { head: { sha: 'new-sha' }, labels: ['ready'] }],
        ['scope label is removed', { head: { sha: 'same-sha' }, labels: [] }],
    ])(
        'holds approval if the %s before the provider call',
        async (_, latest) => {
            const { cron, deps } = makeCron();
            deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                PullRequestReviewState.PENDING,
            );
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
                deps.codeManagementService.getReviewStatusByPullRequest.mock
                    .invocationCallOrder[0],
            ).toBeLessThan(
                deps.codeManagementService.getPullRequest.mock
                    .invocationCallOrder[1],
            );
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.getAllCommentsInPullRequest,
            ).not.toHaveBeenCalled();
        },
    );

    it('holds approval if the base changes after directory policy resolution', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
            PullRequestReviewState.PENDING,
        );
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                dataExecution: {
                    lastAnalyzedCommit: 'same-sha',
                    approvalDecision: { kind: 'approve' },
                },
            },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue({
            head: { sha: 'same-sha' },
            base: { sha: 'new-base' },
            labels: ['ready'],
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
            currentPullRequest: {
                head: { sha: 'same-sha' },
                base: { sha: 'old-base' },
                labels: ['ready'],
                user: { login: 'alice' },
            },
            directoryChangedPaths: ['src/auth/login.ts'],
        });

        expect(result).toBe(false);
        expect(deps.codeManagementService.getPullRequest).toHaveBeenCalledTimes(
            1,
        );
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalled();
    });

    it.each(['initial', 'final'])(
        'holds directory approval when the %s target commit is unavailable',
        async (missingAt) => {
            const { cron, deps } = makeCron();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalDecision: { kind: 'approve' },
                    },
                },
            );
            deps.codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                PullRequestReviewState.PENDING,
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'same-sha' },
                base: missingAt === 'final' ? {} : { sha: 'base-1' },
                labels: ['ready'],
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
                currentPullRequest: {
                    head: { sha: 'same-sha' },
                    base: missingAt === 'initial' ? {} : { sha: 'base-1' },
                    labels: ['ready'],
                    user: { login: 'alice' },
                },
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalled();
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

    it.each(['same-sha', 'new-sha'])(
        'uses the failed rerun instead of an older low judgment (head=%s)',
        async (head) => {
            const { cron, deps } = makeCron();
            const executions = [
                {
                    status: AutomationStatus.PARTIAL_ERROR,
                    dataExecution: {
                        lastAnalyzedCommit: head,
                        approvalRisk: {
                            level: 'unknown',
                            reviewedHeadSha: head,
                            reason: 'Kody could not assess risk for this PR.',
                        },
                        approvalDecision: {
                            kind: 'hold',
                            reason: 'Kody could not assess risk for the current PR head.',
                        },
                    },
                },
                {
                    status: AutomationStatus.SUCCESS,
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalRisk: {
                            level: 'low',
                            reviewedHeadSha: 'same-sha',
                            reason: 'Looks safe.',
                        },
                        approvalDecision: {
                            kind: 'hold',
                            reason: 'The review is not clean.',
                        },
                    },
                },
            ];
            deps.codeManagementService.getReviewStatusByPullRequest
                .mockResolvedValueOnce(PullRequestReviewState.NONE)
                .mockResolvedValueOnce(PullRequestReviewState.APPROVED);
            // Emulate the repository's newest matching row, not a constant mock.
            deps.automationExecutionService.findLatestExecutionByFilters.mockImplementation(
                async ({ status }) =>
                    executions.find((execution) =>
                        [status].flat().includes(execution.status),
                    ),
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: head },
                user: { login: 'alice' },
            });
            deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
                [{ id: 1, isResolved: true }],
            );
            const result = await (cron as any).shouldApprovePR({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                pr: {
                    ...makeOpenPr(77, 'repo-b'),
                    suggestions: [{ comment: { id: 1 } }],
                },
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
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: formatApprovalReasonComment(
                        'hold',
                        'Kody could not assess risk for the current PR head.',
                    ),
                }),
                PlatformType.GITLAB,
            );
        },
    );

    it.each([false, true])(
        'never makes partial reviews approvable when risk is enabled=%s',
        async (assessRisk) => {
            const { cron, deps } = makeCron();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                {
                    status: AutomationStatus.PARTIAL_ERROR,
                    dataExecution: {
                        lastAnalyzedCommit: 'same-sha',
                        approvalRisk: {
                            level: 'low',
                            reviewedHeadSha: 'same-sha',
                            reason: 'Looks safe.',
                        },
                    },
                },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'same-sha' },
                user: { login: 'alice' },
            });
            deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
                [{ id: 1, isResolved: true }],
            );
            expect(
                await (cron as any).shouldApprovePR({
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    pr: {
                        ...makeOpenPr(77, 'repo-b'),
                        suggestions: [{ comment: { id: 1 } }],
                    },
                    codeReviewConfig: {
                        pullRequestApprovalActive: true,
                        approvalRiskActive: assessRisk,
                    },
                    teamAutomationId: 'team-automation-1',
                }),
            ).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
        },
    );

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

    it('ignores a stale risk assessment when risk approval is disabled', async () => {
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
        deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
            [{ id: 1, isResolved: true }],
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 1 } }],
            },
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalRiskActive: false,
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(true);
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).toHaveBeenCalledTimes(1);
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
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 1 } }],
            },
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalSensitivePaths: ['src/auth/**'],
            },
            teamAutomationId: 'team-automation-1',
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.getFilesByPullRequestId,
        ).toHaveBeenCalledWith(
            expect.not.objectContaining({ headSha: expect.anything() }),
            expect.anything(),
        );
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', null],
        ['empty', []],
        ['pathless', [{ filename: undefined }]],
    ])(
        'holds and explains an %s sensitive-path file list',
        async (_label, files) => {
            const { cron, deps } = makeCron();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'same-sha' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'same-sha' },
                user: { login: 'alice' },
            });
            deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue(
                files,
            );

            const result = await (cron as any).shouldApprovePR({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                pr: {
                    ...makeOpenPr(77, 'repo-b'),
                    suggestions: [{ comment: { id: 1 } }],
                },
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
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.stringContaining(
                        'incomplete changed-file list',
                    ),
                }),
                PlatformType.GITLAB,
            );
        },
    );

    it('holds and explains a sensitive-path file lookup failure', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            { dataExecution: { lastAnalyzedCommit: 'same-sha' } },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue({
            head: { sha: 'same-sha' },
            user: { login: 'alice' },
        });
        deps.codeManagementService.getFilesByPullRequestId.mockRejectedValue(
            new Error('provider unavailable'),
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 1 } }],
            },
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
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('could not be verified'),
            }),
            PlatformType.GITLAB,
        );
    });

    it('reuses the verified directory file list for sensitive-path approval', async () => {
        const { cron, deps } = makeCron();
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            { dataExecution: { lastAnalyzedCommit: 'same-sha' } },
        );
        const currentPullRequest = {
            head: { sha: 'same-sha' },
            base: { sha: 'base-sha' },
            user: { login: 'alice' },
        };
        deps.codeManagementService.getPullRequest.mockResolvedValue(
            currentPullRequest,
        );

        const result = await (cron as any).shouldApprovePR({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 1 } }],
            },
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                approvalSensitivePaths: ['src/auth/**'],
            },
            teamAutomationId: 'team-automation-1',
            currentPullRequest,
            directoryChangedPaths: ['src/auth/login.ts'],
        });

        expect(result).toBe(false);
        expect(
            deps.codeManagementService.getFilesByPullRequestId,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.checkIfPullRequestShouldBeApproved,
        ).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining('src/auth/login.ts'),
            }),
            PlatformType.GITLAB,
        );
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
            pr: {
                ...makeOpenPr(77, 'repo-b'),
                suggestions: [{ comment: { id: 'c-1' } }],
            },
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
            [
                {
                    repositoryId: 'repo-a',
                    pullRequestNumber: 7,
                    mayAllowNoComments: true,
                },
                {
                    repositoryId: 'repo-b',
                    pullRequestNumber: 8,
                    mayAllowNoComments: false,
                },
            ],
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
        ).toHaveBeenCalledWith(
            'org-1',
            [
                expect.objectContaining({
                    repositoryId: 'repo-a',
                    pullRequestNumber: 7,
                }),
            ],
            PullRequestState.OPENED,
        );
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
        const shouldApprove = jest
            .spyOn(cron as any, 'shouldApprovePR')
            .mockResolvedValue(false);

        await cron.handleCron();

        expect(
            deps.automationExecutionService.findLatestExecutionByFilters,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                status: [
                    AutomationStatus.SUCCESS,
                    AutomationStatus.PARTIAL_ERROR,
                ],
            }),
        );
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
        expect(shouldApprove).toHaveBeenCalledWith(
            expect.objectContaining({
                directoryChangedPaths: ['src/auth/file-1.ts'],
            }),
        );
        expect(shouldApprove).toHaveBeenCalledWith(
            expect.objectContaining({
                directoryChangedPaths: ['src/auth/file-2.ts'],
            }),
        );
    });

    it('reuses directory file paths until the reviewed head changes', async () => {
        const { cron, deps } = makeCron();
        deps.codeManagementService.getPullRequest
            .mockResolvedValueOnce({ head: { sha: 'head-1' } })
            .mockResolvedValueOnce({ head: { sha: 'head-1' } })
            .mockResolvedValueOnce({ head: { sha: 'head-2' } });
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
            [{ repositoryId: 'repo-a', pullRequestNumber: 1 }],
        );
        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(1, 'repo-a')],
        );
        deps.automationExecutionService.findLatestExecutionByFilters
            .mockResolvedValueOnce({
                dataExecution: { lastAnalyzedCommit: 'head-1' },
            })
            .mockResolvedValueOnce({
                dataExecution: { lastAnalyzedCommit: 'head-1' },
            })
            .mockResolvedValueOnce({
                dataExecution: { lastAnalyzedCommit: 'head-2' },
            });
        deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue([
            { filename: 'src/auth/session.ts' },
        ]);
        jest.spyOn(cron as any, 'shouldApprovePR').mockResolvedValue(false);

        await cron.handleCron();
        await cron.handleCron();
        expect(
            deps.codeManagementService.getFilesByPullRequestId,
        ).toHaveBeenCalledTimes(1);

        await cron.handleCron();
        expect(
            deps.codeManagementService.getFilesByPullRequestId,
        ).toHaveBeenCalledTimes(2);
    });

    it('does not resolve directory policy from files when the live PR has no head', async () => {
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
            [{ repositoryId: 'repo-a', pullRequestNumber: 1 }],
        );
        deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [makeOpenPr(1, 'repo-a')],
        );
        deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            { dataExecution: { lastAnalyzedCommit: 'head-1' } },
        );
        deps.codeManagementService.getPullRequest.mockResolvedValue(undefined);

        await cron.handleCron();

        expect(
            deps.codeManagementService.getFilesByPullRequestId,
        ).not.toHaveBeenCalled();
        expect(deps.codeBaseConfigService.getConfig).not.toHaveBeenCalled();
        expect(
            deps.codeManagementService.createIssueComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining(
                    'source commit could not be verified',
                ),
            }),
            PlatformType.GITLAB,
        );
    });

    it('reuses directory files across TTL only while both head and base are unchanged', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(0);
        try {
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
                [{ repositoryId: 'repo-a', pullRequestNumber: 1 }],
            );
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [makeOpenPr(1, 'repo-a')],
            );
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'head-1' } },
            );
            deps.codeManagementService.getPullRequest
                .mockResolvedValueOnce({
                    head: { sha: 'head-1' },
                    base: { sha: 'base-1' },
                })
                .mockResolvedValueOnce({
                    head: { sha: 'head-1' },
                    base: { sha: 'base-1' },
                })
                .mockResolvedValueOnce({
                    head: { sha: 'head-1' },
                    base: { sha: 'base-2' },
                })
                .mockResolvedValueOnce({
                    head: { sha: 'head-2' },
                    base: { sha: 'base-2' },
                });
            deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue(
                [{ filename: 'src/auth/session.ts' }],
            );
            const shouldApprove = jest
                .spyOn(cron as any, 'shouldApprovePR')
                .mockResolvedValue(false);

            await cron.handleCron();
            now.mockReturnValue(11 * 60 * 1000);
            await cron.handleCron();
            expect(
                deps.codeManagementService.getFilesByPullRequestId,
            ).toHaveBeenCalledTimes(1);

            await cron.handleCron();
            expect(
                deps.codeManagementService.getFilesByPullRequestId,
            ).toHaveBeenCalledTimes(2);
            expect(
                deps.codeManagementService.getFilesByPullRequestId,
            ).toHaveBeenNthCalledWith(
                2,
                expect.not.objectContaining({ headSha: expect.anything() }),
                expect.anything(),
            );
            expect(
                deps.codeManagementService.getPullRequest,
            ).toHaveBeenCalledTimes(3);
            expect(shouldApprove).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    currentPullRequest: expect.objectContaining({
                        base: { sha: 'base-2' },
                    }),
                }),
            );

            await cron.handleCron();
            expect(
                deps.codeManagementService.getFilesByPullRequestId,
            ).toHaveBeenCalledTimes(2);
            expect(shouldApprove).toHaveBeenCalledTimes(3);
        } finally {
            now.mockRestore();
        }
    });

    it('stops approval when the directory file lookup stalls', async () => {
        jest.useFakeTimers();
        try {
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
                [{ repositoryId: 'repo-a', pullRequestNumber: 1 }],
            );
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [makeOpenPr(1, 'repo-a')],
            );
            deps.codeManagementService.getFilesByPullRequestId.mockReturnValue(
                new Promise(() => {}),
            );
            const shouldApprove = jest.spyOn(cron as any, 'shouldApprovePR');

            const run = cron.handleCron();
            await jest.advanceTimersByTimeAsync(10_000);
            await run;

            expect(shouldApprove).not.toHaveBeenCalled();
            expect(deps.distributedLockService.acquire).toHaveBeenCalled();
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.stringContaining(
                        'timed out while loading changed files',
                    ),
                }),
                PlatformType.GITLAB,
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it.each([
        ['empty', [], 'returned no changed files'],
        ['missing', null, 'returned no changed files'],
        ['pathless', [{ filename: undefined }], 'did not return a path'],
    ])(
        'explains why approval is held when the provider returns %s files',
        async (_label, files, reason) => {
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
                [{ repositoryId: 'repo-a', pullRequestNumber: 1 }],
            );
            deps.pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [makeOpenPr(1, 'repo-a')],
            );
            deps.codeManagementService.getFilesByPullRequestId.mockResolvedValue(
                files,
            );
            const shouldApprove = jest.spyOn(cron as any, 'shouldApprovePR');

            await cron.handleCron();

            expect(shouldApprove).not.toHaveBeenCalled();
            expect(deps.codeBaseConfigService.getConfig).not.toHaveBeenCalled();
            expect(
                deps.codeManagementService.createIssueComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.stringContaining(reason),
                }),
                PlatformType.GITLAB,
            );
        },
    );

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
