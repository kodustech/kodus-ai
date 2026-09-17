import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';

import { UpdateCommentsAndGenerateSummaryStage } from './finish-comments.stage';
import { RequestChangesOrApproveStage } from './finish-process-review.stage';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * FLOW test for #1844 — chains the two REAL stage instances exactly as the
 * pipeline runs them (UpdateCommentsAndGenerateSummaryStage ->
 * RequestChangesOrApproveStage, `context = await stage.execute(context)` per
 * stage, same as PipelineExecutor's core loop), with only the true EXTERNAL
 * boundaries mocked (commentManagerService's LLM-backed summary call,
 * codeManagementService's GitHub/GitLab/etc. calls). Nothing about the two
 * stages' own logic — the try/catch that records the summary error, the
 * `metadata.reason` shape, the `reviewHasFailures` gate reading it back — is
 * stubbed or hand-assumed here; the SECOND stage reads whatever `errors`
 * shape the FIRST stage's real code actually produced. This is what the two
 * unit specs (finish-comments.stage.spec.ts / finish-process-review.stage
 * .spec.ts) each individually mocked away to test their own stage in
 * isolation — this file proves the SEAM between them.
 */
describe('#1844 flow: summary generation failure -> auto-approve decision', () => {
    const makeSummaryStage = (
        generateSummaryPR: jest.Mock,
    ): { stage: UpdateCommentsAndGenerateSummaryStage } => {
        const commentManagerService = {
            generateSummaryPR,
            updateSummarizationInPR: jest.fn().mockResolvedValue(undefined),
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
        } as any;
        return {
            stage: new UpdateCommentsAndGenerateSummaryStage(
                commentManagerService,
                {} as any, // pullRequestManagerService — unused (no dry-run/summary-only path here)
                {
                    execute: jest.fn().mockResolvedValue({
                        action: 'skipped',
                        reason: 'no-decisions',
                    }),
                } as any, // postTracePrCommentUseCase
            ),
        };
    };

    const makeApproveStage = () => {
        const codeManagement = {
            approvePullRequest: jest.fn().mockResolvedValue(undefined),
            getReviewStatusByPullRequest: jest
                .fn()
                .mockResolvedValue(PullRequestReviewState.PENDING),
            requestChangesPullRequest: jest.fn().mockResolvedValue(undefined),
        };
        const notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        const prAuthorResolver = { resolve: jest.fn().mockResolvedValue(null) };
        const stage = new RequestChangesOrApproveStage(
            codeManagement as any,
            notificationService as any,
            prAuthorResolver as any,
        );
        return { stage, codeManagement, notificationService };
    };

    // A genuinely clean PR: zero findings, auto-approve on, generatePRSummary
    // on. The exact configuration the feature exists for.
    const baseContext = () =>
        frozenContext({
            lastExecution: undefined,
            organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' } as any,
            repository: { id: 'repo-1', name: 'acme/api' } as any,
            pullRequest: {
                number: 42,
                url: 'https://github.com/acme/api/pull/42',
                user: { email: 'alex@acme.com', username: 'alex' },
            } as any,
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            lineComments: [],
            codeReviewConfig: {
                languageResultPrompt: 'en-US',
                summary: { generatePRSummary: true },
                pullRequestApprovalActive: true,
                isRequestChangesActive: false,
            } as any,
            errors: [],
        }) as any;

    it('auto-approves a clean PR end-to-end even though generateSummaryPR threw', async () => {
        const { stage: summaryStage } = makeSummaryStage(
            jest
                .fn()
                .mockRejectedValue(
                    new Error(
                        'Failed after 3 attempts. Last error: AI_APICallError: <none>',
                    ),
                ),
        );
        const { stage: approveStage, codeManagement } = makeApproveStage();

        // Real seam: whatever errors[] UpdateCommentsAndGenerateSummaryStage's
        // OWN catch block actually produces is what RequestChangesOrApproveStage
        // reads next — nothing hand-assumed between the two calls.
        const afterSummary = await summaryStage.execute(baseContext());
        expect(afterSummary.errors).toHaveLength(1);
        expect(afterSummary.errors[0].metadata?.reason).toBe(
            'summary_generation_failed',
        );

        await approveStage.execute(afterSummary);

        expect(codeManagement.approvePullRequest).toHaveBeenCalled();
    });

    it('still refuses to approve end-to-end when the review itself also failed', async () => {
        // Same broken summary call, but the PR is NOT clean this time — the
        // agent flagged a critical severity finding, the case auto-approve
        // must never fire for regardless of the summary outcome.
        const { stage: summaryStage } = makeSummaryStage(
            jest.fn().mockRejectedValue(new Error('summary boom')),
        );
        const { stage: approveStage, codeManagement } = makeApproveStage();

        const dirtyContext = {
            ...baseContext(),
            errors: [
                {
                    stage: 'AgentReviewStage',
                    error: new Error('byok auth failed'),
                    severity: 'critical',
                } as any,
            ],
        };

        const afterSummary = await summaryStage.execute(dirtyContext as any);
        // Both errors present: the pre-existing critical one AND the fresh
        // summary one — proves the summary stage's own updateContext path
        // appends rather than clobbers (the #1568 concern), in the SAME real
        // call this test then feeds forward.
        expect(afterSummary.errors).toHaveLength(2);

        await approveStage.execute(afterSummary);

        expect(codeManagement.approvePullRequest).not.toHaveBeenCalled();
    });
});
