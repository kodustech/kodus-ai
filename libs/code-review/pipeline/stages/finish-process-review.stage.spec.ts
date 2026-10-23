import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { Test, TestingModule } from '@nestjs/testing';

import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { RequestChangesOrApproveStage } from './finish-process-review.stage';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('RequestChangesOrApproveStage — review.auto_approved emit', () => {
    let stage: RequestChangesOrApproveStage;
    let codeManagement: jest.Mocked<
        Pick<
            CodeManagementService,
            | 'approvePullRequest'
            | 'getReviewStatusByPullRequest'
            | 'requestChangesPullRequest'
            | 'createIssueComment'
            | 'dismissOwnPullRequestApprovals'
        >
    >;
    let notificationService: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let prAuthorResolver: jest.Mocked<
        Pick<PrAuthorRecipientResolver, 'resolve'>
    >;
    let commentManager: { postApprovalReason: jest.Mock };

    // Frozen by DEFAULT — production hands every stage after the first
    // produce() a deep-frozen context. See test/fixtures/frozen-pipeline-context.ts.
    const makeContext = (
        over: Record<string, unknown> = {},
    ): CodeReviewPipelineContext =>
        frozenContext({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            repository: { id: 'repo-1', name: 'acme/api' } as any,
            pullRequest: {
                number: 42,
                url: 'https://github.com/acme/api/pull/42',
                user: { email: 'alex@acme.com', username: 'alex' },
            } as any,
            lineComments: [],
            codeReviewConfig: {
                pullRequestApprovalActive: true,
                isRequestChangesActive: false,
            } as any,
            ...over,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        codeManagement = {
            approvePullRequest: jest.fn().mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest
                .fn()
                .mockResolvedValue(PullRequestReviewState.PENDING),
            requestChangesPullRequest: jest.fn().mockResolvedValue(undefined),
            createIssueComment: jest.fn().mockResolvedValue(undefined),
            dismissOwnPullRequestApprovals: jest.fn().mockResolvedValue(1),
        };
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        prAuthorResolver = { resolve: jest.fn() };
        commentManager = {
            postApprovalReason: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RequestChangesOrApproveStage,
                { provide: CodeManagementService, useValue: codeManagement },
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: commentManager,
                },
                { provide: NotificationService, useValue: notificationService },
                {
                    provide: PrAuthorRecipientResolver,
                    useValue: prAuthorResolver,
                },
            ],
        }).compile();

        stage = module.get(RequestChangesOrApproveStage);
    });

    it('emits review.auto_approved when the PR is auto-approved AND the author resolves', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });

        await stage.execute(makeContext());

        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
        expect(prAuthorResolver.resolve).toHaveBeenCalledWith(
            { email: 'alex@acme.com', login: 'alex' },
            'org-1',
        );
        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.REVIEW_AUTO_APPROVED,
                organizationId: 'org-1',
                recipients: { kind: 'user', userId: 'user-1' },
                payload: expect.objectContaining({
                    prUrl: 'https://github.com/acme/api/pull/42',
                    repoName: 'acme/api',
                    approvedAt: expect.any(String),
                }),
            }),
        );
    });

    it('does not emit when author is a bot / external (resolver returns null)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);

        await stage.execute(makeContext());

        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('does not emit when approval is skipped due to existing line comments', async () => {
        // any comment short-circuits approval
        const ctx = makeContext({ lineComments: [{}] as any });

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('keeps legacy approval eligibility when only a PR-level comment exists', async () => {
        await stage.execute(
            makeContext({ prLevelCommentResults: [{}] as any }),
        );

        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
    });

    it('posts the reason after a conditional approval when end-review messages are off', async () => {
        await stage.execute(
            makeContext({
                codeReviewConfig: {
                    pullRequestApprovalActive: true,
                    approvalAuthors: ['alex'],
                } as any,
                approvalDecision: {
                    kind: 'approve',
                    reason: 'Clean review.\nPlease deploy now.',
                },
                pullRequestMessagesConfig: {
                    endReviewMessage: {
                        status: PullRequestMessageStatus.OFF,
                    },
                } as any,
            }),
        );

        expect(commentManager.postApprovalReason).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
            }),
            42,
            expect.objectContaining({ id: 'repo-1' }),
            'Clean review.\nPlease deploy now.',
            'approve',
        );
    });

    it('records a partial failure with review identifiers when the approval reason cannot be posted', async () => {
        const publicationError = new Error('comment write failed');
        commentManager.postApprovalReason.mockRejectedValueOnce(
            publicationError,
        );

        const result = await stage.execute(
            makeContext({
                codeReviewConfig: {
                    pullRequestApprovalActive: true,
                    approvalAuthors: ['alex'],
                } as any,
                approvalDecision: {
                    kind: 'approve',
                    reason: 'Clean review and allowed author.',
                },
                pullRequestMessagesConfig: {
                    endReviewMessage: {
                        status: PullRequestMessageStatus.OFF,
                    },
                } as any,
            }),
        );

        expect(result.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    substage: 'approval-reason-publication',
                    severity: 'partial',
                    error: publicationError,
                }),
            ]),
        );
        expect((stage as any).logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    repositoryId: 'repo-1',
                    prNumber: 42,
                },
            }),
        );
        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
    });

    it('holds a clean PR when the approval policy judged it risky', async () => {
        await stage.execute(
            makeContext({
                approvalDecision: {
                    kind: 'hold',
                    reason: 'Authentication change needs a human.',
                },
            }),
        );

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('dismisses Kody approvals when a new GitHub review holds approval', async () => {
        await stage.execute(
            makeContext({
                platformType: PlatformType.GITHUB,
                approvalDecision: {
                    kind: 'hold',
                    reason: 'Sensitive path changed.',
                },
            }),
        );

        expect(
            codeManagement.dismissOwnPullRequestApprovals,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 42,
                reason: 'Sensitive path changed.',
            }),
        );
        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
    });

    it('records a failed dismissal so an old GitHub approval is not silent', async () => {
        codeManagement.dismissOwnPullRequestApprovals.mockRejectedValueOnce(
            new Error('GitHub denied dismissal'),
        );
        const result = await stage.execute(
            makeContext({
                platformType: PlatformType.GITHUB,
                approvalDecision: {
                    kind: 'hold',
                    reason: 'Sensitive path changed.',
                },
            }),
        );

        expect(result.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ substage: 'dismiss-prior-approval' }),
            ]),
        );
    });

    it('holds when a configured policy has no decision', async () => {
        await stage.execute(
            makeContext({
                codeReviewConfig: {
                    pullRequestApprovalActive: true,
                    isRequestChangesActive: false,
                    approvalRiskActive: true,
                } as any,
            }),
        );

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
    });

    it('does not emit when PR is already in APPROVED state', async () => {
        codeManagement.getReviewStatusByPullRequest.mockResolvedValueOnce(
            PullRequestReviewState.APPROVED,
        );

        await stage.execute(makeContext());

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('does not emit when approve API throws', async () => {
        codeManagement.approvePullRequest.mockRejectedValueOnce(
            new Error('GitHub API 500'),
        );

        await stage.execute(makeContext());

        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('swallows notification errors so the pipeline never fails over notify', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });
        notificationService.emit.mockRejectedValueOnce(
            new Error('outbox down'),
        );

        await expect(stage.execute(makeContext())).resolves.toBeDefined();
    });

    it('does not approve when the review has a critical failure', async () => {
        // critical errors[] entries mean the main agent / a structural
        // stage failed — 0 line comments here is not a clean PR, it's
        // an unanalyzed one. The stage must refuse to approve.
        const ctx = makeContext({
            errors: [
                {
                    stage: 'AgentReviewStage',
                    error: new Error('byok auth failed'),
                    severity: 'critical',
                } as any,
            ] as any,
        });

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('does not approve on any partial failure (regardless of which stage)', async () => {
        // Any partial-severity entry means some part of the review didn't
        // run cleanly; auto-approve must wait for the user to decide.
        const ctx = makeContext({
            errors: [
                {
                    stage: 'ValidateSuggestionsStage',
                    error: new Error('validator timed out'),
                    severity: 'partial',
                } as any,
            ] as any,
        });

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    // #1844: a summary-only failure must NOT block auto-approve. By the time
    // this stage runs, the actual review output (PR-level + line comments)
    // already posted several stages earlier (createPrLevelComments ->
    // createFileComments -> aggregateResults -> updateCommentsAndGenerateSummary
    // -> HERE) — a broken PR-summary narrative says nothing about whether
    // that already-posted review is trustworthy. Proved failing before the
    // fix: a clean PR (0 findings) with ONLY this error never called
    // approvePullRequest.
    it('DOES approve a clean PR whose only error is a summary-generation failure', async () => {
        const ctx = makeContext({
            errors: [
                {
                    stage: 'UpdateCommentsAndGenerateSummaryStage',
                    error: new Error(
                        'Failed after 3 attempts. Last error: AI_APICallError: <none>',
                    ),
                    severity: 'partial',
                    metadata: {
                        message: 'Failed to generate summary',
                        reason: 'summary_generation_failed',
                    },
                } as any,
            ] as any,
        });

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
    });

    it('still refuses to approve when a summary failure co-occurs with a REAL partial failure', async () => {
        // The exclusion is scoped to the summary's own error, not to
        // "partial in general" — a genuinely concerning partial failure
        // alongside it still blocks, unchanged.
        const ctx = makeContext({
            errors: [
                {
                    stage: 'UpdateCommentsAndGenerateSummaryStage',
                    error: new Error('summary boom'),
                    severity: 'partial',
                    metadata: { reason: 'summary_generation_failed' },
                } as any,
                {
                    stage: 'ValidateSuggestionsStage',
                    error: new Error('validator timed out'),
                    severity: 'partial',
                } as any,
            ] as any,
        });

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
    });

    it('does not approve after a `@kody -v <agent>` run, which ran that one agent only', async () => {
        await stage.execute(makeContext({ onlyCustomAgent: 'ledger-rules' }));

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
    });
});
