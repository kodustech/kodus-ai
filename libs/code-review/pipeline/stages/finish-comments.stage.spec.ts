import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { UpdateCommentsAndGenerateSummaryStage } from './finish-comments.stage';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

/**
 * Guards the stage→commentManager seam that feeds the @agentPrompt
 * block: executeStage must forward `context.lineComments` as the (positional,
 * optional) lineComments argument to processEndReviewMessageTemplate. Reordering
 * or dropping that trailing arg wouldn't trip a typecheck — the class of silent
 * break that only an end-to-end assertion catches.
 */
describe('UpdateCommentsAndGenerateSummaryStage - lineComments forwarding', () => {
    const makeStage = () => {
        const commentManagerService = {
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
        } as any;
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            {} as any, // pullRequestManagerService — unused when summary is off
            {
                execute: jest.fn().mockResolvedValue({
                    action: 'skipped',
                    reason: 'no-decisions',
                }),
            } as any, // postTracePrCommentUseCase
        );
        return { stage, commentManagerService };
    };

    const lineComments = [
        {
            comment: {
                path: 'src/x.ts',
                line: 4,
                body: {},
                suggestion: { llmPrompt: 'Fix it', improvedCode: '' },
            },
            deliveryStatus: 'sent',
        },
    ];

    // Frozen by DEFAULT — the shape production hands this stage. This spec's
    // own subject once threw INSIDE its catch because `context.errors.push()`
    // hit the freeze (#1548). See test/fixtures/frozen-pipeline-context.ts.
    const baseContext = (over: Record<string, unknown> = {}) =>
        frozenContext({
            lastExecution: undefined,
            errors: [],
            // No summary config → shouldGenerateOrUpdateSummary is false, so the
            // heavy generateSummaryPR branch is skipped entirely.
            codeReviewConfig: { languageResultPrompt: 'en-US' },
            repository: { id: 'r' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            lineComments,
            // Both messages ACTIVE → the branch that calls
            // processEndReviewMessageTemplate.
            pullRequestMessagesConfig: {
                startReviewMessage: {
                    status: PullRequestMessageStatus.ACTIVE,
                    content: 'Review started',
                },
                endReviewMessage: {
                    status: PullRequestMessageStatus.ACTIVE,
                    content: 'Done!\n\n@agentPrompt',
                },
            },
            ...over,
        }) as any;

    it('forwards context.lineComments as the trailing arg to processEndReviewMessageTemplate', async () => {
        const { stage, commentManagerService } = makeStage();
        const context = baseContext();

        await (stage as any).executeStage(context);

        expect(
            commentManagerService.processEndReviewMessageTemplate,
        ).toHaveBeenCalledTimes(1);
        expect(
            commentManagerService.processEndReviewMessageTemplate,
        ).toHaveBeenCalledWith(
            'Done!\n\n@agentPrompt',
            context.changedFiles,
            context.organizationAndTeamData,
            7,
            context.codeReviewConfig,
            'en-US',
            undefined,
            lineComments,
        );
    });
});

describe('UpdateCommentsAndGenerateSummaryStage - Trace pack forwarding', () => {
    it('passes the exact selected prompt decisions to the sticky comment', async () => {
        const postTrace = {
            execute: jest.fn().mockResolvedValue({ action: 'created' }),
        };
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            {} as any,
            {} as any,
            postTrace as any,
        );
        const selected = [
            {
                type: 'convention',
                decision: 'Use the repository-scoped adapter',
                scope: ['src/trace'],
                pinned: true,
            },
        ];
        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo-1' },
            traceDecisions: selected,
            dryRun: { enabled: false },
        };

        await (stage as any).postTraceComment(context);

        expect(postTrace.execute).toHaveBeenCalledWith(
            expect.objectContaining({ decisions: selected }),
        );
        expect(postTrace.execute.mock.calls[0][0].decisions).toBe(selected);
    });
});

/**
 * Guards the frozen-context error-recording path (issue #1452 matrix-gaps
 * item 3, same family as create-file-comments #c886e369a / agent-review
 * #1522). By the time this stage runs, an earlier stage has passed the
 * pipeline context through Immer's produce(), so `context` is DEEP-FROZEN
 * (auto-freeze). When PR-summary generation fails, the catch block used to
 * record the error via `context.errors = []` / `context.errors.push(...)` —
 * a direct mutation of the frozen context that throws "Cannot add property,
 * object is not extensible" and, INSIDE the catch, replaced the real summary
 * failure with a confusing frozen-mutation error and aborted the stage. The
 * fix records the error through updateContext(); this test freezes the
 * context exactly like production and asserts the error is recorded without
 * throwing.
 */
describe('UpdateCommentsAndGenerateSummaryStage - frozen-context error recording (regression)', () => {
    const makeStage = () => {
        const commentManagerService = {
            // Summary generation blows up → the catch that records the error.
            generateSummaryPR: jest
                .fn()
                .mockRejectedValue(new Error('summary boom')),
            updateSummarizationInPR: jest.fn().mockResolvedValue(undefined),
            // Reached after the summary catch (no endReviewMessage config).
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
        } as any;
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            {} as any,
            {
                execute: jest.fn().mockResolvedValue({
                    action: 'skipped',
                    reason: 'no-decisions',
                }),
            } as any, // postTracePrCommentUseCase
        );
        return { stage, commentManagerService };
    };

    const summaryFailContext = () =>
        frozenContext({
            lastExecution: undefined, // isCommitRun=false
            // generatePRSummary=true → shouldGenerateOrUpdateSummary=true,
            // entering the try/catch whose failure path records the error.
            codeReviewConfig: {
                languageResultPrompt: 'en-US',
                summary: { generatePRSummary: true },
            },
            repository: { id: 'r' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            lineComments: [],
            // A frozen, already-initialized errors array — the realistic
            // shape. The old code's `context.errors.push(...)` throws on it.
            errors: [],
        }) as any;

    it('records the summary failure without throwing when the context is Immer-frozen', async () => {
        const { stage } = makeStage();
        // summaryFailContext() is deep-frozen by default.
        const frozenCtx = summaryFailContext();

        // The whole point: the OLD implementation threw here
        // ("Cannot add property N, object is not extensible") because the
        // catch mutated the frozen context/array in place.
        const result = await (stage as any).executeStage(frozenCtx);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].metadata.reason).toBe(
            'summary_generation_failed',
        );
    });

    it('appends to a frozen non-empty errors array without dropping the prior error', async () => {
        const { stage } = makeStage();
        const priorError = {
            stage: 'earlier-stage',
            error: new Error('earlier'),
            metadata: { reason: 'earlier_failure' },
        };
        const frozenCtx = frozenContext({
            ...summaryFailContext(),
            errors: [priorError],
        } as any);

        const result = await (stage as any).executeStage(frozenCtx);

        // Both the pre-existing error and the newly-recorded summary error
        // survive — the updateContext path must not clobber the array.
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].metadata.reason).toBe('earlier_failure');
        expect(result.errors[1].metadata.reason).toBe(
            'summary_generation_failed',
        );
    });

    // The recorded error has to reach BOTH downstream readers, or a failed
    // summary is indistinguishable from a clean review: the approve gate
    // (which reads errors[].severity) and the end-review comment (which is
    // rendered by this same stage, AFTER the summary attempt).
    it('marks the summary failure as partial so the approve gate holds back', async () => {
        const { stage } = makeStage();

        const result = await (stage as any).executeStage(summaryFailContext());

        expect(result.errors[0].severity).toBe('partial');
    });

    it('records lastReviewError so the PR comment can name the provider failure', async () => {
        const { stage, commentManagerService } = makeStage();
        commentManagerService.generateSummaryPR.mockRejectedValue(
            Object.assign(new Error('Path not found: /chat/completions'), {
                name: 'AI_APICallError',
                statusCode: 404,
            }),
        );

        const result = await (stage as any).executeStage(summaryFailContext());

        expect(result.lastReviewError?.friendlyMessage).toBeTruthy();
    });

    it('tells the end-review comment about a failure recorded by its own summary attempt', async () => {
        const { stage, commentManagerService } = makeStage();

        await (stage as any).executeStage(summaryFailContext());

        // updateOverallComment(..., reviewFailed, reviewErrorMessage,
        // reviewHasPartialErrors, reviewErrorCustomMessage). These flags used
        // to be read once at stage entry — before the summary ran — so a failed
        // summary still rendered "review completed" (#1568).
        // Index shifted by -1 after the dry-run parameter (formerly arg 10)
        // was removed together with the dry-run feature; reviewHasPartialErrors
        // is now the 13th arg (0-indexed 12) instead of the 14th.
        const args = commentManagerService.updateOverallComment.mock.calls[0];
        expect(args[12]).toBe(true); // reviewHasPartialErrors
    });

    // Regression: the summary must route by the `prSummary` task, not reuse the
    // `codeReview`-resolved slot. Forwarding codeReviewConfig.byokConfig made the
    // summary silently run the review model and skip any prSummary override.
    it('never forwards the code-review byokConfig to the summary (routes prSummary itself)', async () => {
        const generateSummaryPR = jest.fn().mockResolvedValue('summary text');
        const commentManagerService = {
            generateSummaryPR,
            updateSummarizationInPR: jest.fn().mockResolvedValue(undefined),
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
        } as any;
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            {} as any,
        );

        const ctx = frozenContext({
            ...summaryFailContext(),
            codeReviewConfig: {
                languageResultPrompt: 'en-US',
                summary: { generatePRSummary: true },
                // A code-review-resolved slot the summary must IGNORE.
                byokConfig: {
                    main: {
                        provider: 'openai',
                        model: 'code-review-model',
                        apiKey: 'x',
                    },
                },
            },
        } as any);

        await (stage as any).executeStage(ctx);

        expect(generateSummaryPR).toHaveBeenCalledTimes(1);
        // The code-review-resolved slot must not reach the summary at all —
        // generateSummaryPR takes no byokConfig arg and routes prSummary itself.
        expect(generateSummaryPR.mock.calls[0]).not.toContainEqual(
            ctx.codeReviewConfig.byokConfig,
        );
    });
});
