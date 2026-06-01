import { Test, TestingModule } from '@nestjs/testing';

import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { RequestChangesOrApproveStage } from './finish-process-review.stage';

jest.mock('@kodus/flow', () => ({
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
        >
    >;
    let notificationService: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let prAuthorResolver: jest.Mocked<Pick<PrAuthorRecipientResolver, 'resolve'>>;

    const makeContext = (): CodeReviewPipelineContext =>
        ({
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
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        codeManagement = {
            approvePullRequest: jest.fn().mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest
                .fn()
                .mockResolvedValue(PullRequestReviewState.PENDING),
            requestChangesPullRequest: jest.fn().mockResolvedValue(undefined),
        };
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        prAuthorResolver = { resolve: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RequestChangesOrApproveStage,
                { provide: CodeManagementService, useValue: codeManagement },
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
        const ctx = makeContext();
        ctx.lineComments = [{}] as any; // any comment short-circuits approval

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
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
        notificationService.emit.mockRejectedValueOnce(new Error('outbox down'));

        await expect(stage.execute(makeContext())).resolves.toBeDefined();
    });

    it('does not approve when the review has a critical failure', async () => {
        // critical errors[] entries mean the main agent / a structural
        // stage failed — 0 line comments here is not a clean PR, it's
        // an unanalyzed one. The stage must refuse to approve.
        const ctx = makeContext();
        ctx.errors = [
            {
                stage: 'AgentReviewStage',
                error: new Error('byok auth failed'),
                severity: 'critical',
            } as any,
        ];

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('does not approve on any partial failure (regardless of which stage)', async () => {
        // Any partial-severity entry means some part of the review didn't
        // run cleanly; auto-approve must wait for the user to decide.
        const ctx = makeContext();
        ctx.errors = [
            {
                stage: 'ValidateSuggestionsStage',
                error: new Error('validator timed out'),
                severity: 'partial',
            } as any,
        ];

        await stage.execute(ctx);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });
});
