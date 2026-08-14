import { Injectable, Inject } from '@nestjs/common';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import {
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
    IPullRequestManagerService,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { createLogger } from '@libs/core/log/logger';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    BehaviourForNewCommits,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    classifyLLMError,
    getClassification,
} from '@libs/llm/error-classifier';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { formatLinkedReposSummaryLine } from '@libs/ee/linked-repositories';
import { PostTracePrCommentUseCase } from '@libs/cli-review/application/use-cases/post-trace-pr-comment.use-case';

@Injectable()
export class UpdateCommentsAndGenerateSummaryStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'UpdateCommentsAndGenerateSummaryStage';
    readonly label = 'Generating Summary';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(
        UpdateCommentsAndGenerateSummaryStage.name,
    );

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestManagerService: IPullRequestManagerService,
        private readonly postTracePrCommentUseCase: PostTracePrCommentUseCase,
    ) {
        super();
    }

    /**
     * The sticky comment carrying the reasoning behind the change.
     *
     * Posted once and edited in place on every later run, and skipped entirely
     * when the PR has no recorded decisions.
     */
    private async postTraceComment(
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        if (!context.traceDecisions?.length) {
            return;
        }

        const outcome = await this.postTracePrCommentUseCase.execute({
            organizationAndTeamData: context.organizationAndTeamData,
            prNumber: context.pullRequest.number,
            repository: context.repository,
            decisions: context.traceDecisions,
            platformType: context.platformType,
            dryRun: context.dryRun,
        });

        this.logger.log({
            message: `Kodus Trace comment ${outcome.action} on PR#${context.pullRequest.number}`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                prNumber: context.pullRequest.number,
                outcome,
            },
        });
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const {
            lastExecution,
            codeReviewConfig,
            repository,
            pullRequest,
            organizationAndTeamData,
            platformType,
            initialCommentData,
            lineComments,
        } = context;

        // A "failed" review (from the user's perspective) is one with a
        // critical pipeline error — main agent rejected, sandbox blew up,
        // validation aborted, etc. Partial failures (kody-rules agent,
        // pr-level comment posting, business-logic validation, etc.)
        // don't get the error variant of the message but DO get a short
        // generic notice appended explaining *why* auto-approve was
        // skipped — otherwise the user sees "review completed" + no
        // approval and assumes auto-approve is broken. Default severity
        // for a pushed error is 'critical' per PipelineErrorSeverity docs.
        // Computed as a closure, not a snapshot: the summary block below can
        // add an error of its own, and the end-review comment must reflect it.
        // Reading these once at stage entry meant a failed summary still
        // rendered "review completed" (#1568).
        const classifyErrors = (ctx: CodeReviewPipelineContext) => {
            const errors = ctx.errors ?? [];
            const reviewFailed = errors.some(
                (e) => (e?.severity ?? 'critical') === 'critical',
            );
            return {
                reviewFailed,
                reviewHasPartialErrors:
                    !reviewFailed &&
                    errors.some((e) => e?.severity === 'partial'),
            };
        };

        // Optional team-authored guidance appended below Kody's default error
        // comment (issue #1452). Honored whenever the review failed and the
        // message has content — the presence of content is the switch (there is
        // no separate on/off toggle for the error message). Empty/unset content
        // leaves the default error comment unchanged. Inherits global →
        // repository → directory like the other custom messages (resolved into
        // pullRequestMessagesConfig upstream).
        const errorReviewMessageConfig =
            context.pullRequestMessagesConfig?.errorReviewMessage;
        const customMessageFor = (reviewFailed: boolean) =>
            reviewFailed && errorReviewMessageConfig?.content?.trim()
                ? errorReviewMessageConfig.content.trim()
                : undefined;

        const isCommitRun = Boolean(lastExecution);
        const commitBehaviour =
            codeReviewConfig?.summary?.behaviourForNewCommits ??
            BehaviourForNewCommits.NONE;

        const shouldGenerateOrUpdateSummary =
            (!isCommitRun && codeReviewConfig?.summary?.generatePRSummary) ||
            (isCommitRun &&
                codeReviewConfig?.summary?.generatePRSummary &&
                commitBehaviour !== BehaviourForNewCommits.NONE);

        if (
            !initialCommentData &&
            !context.pullRequestMessagesConfig?.startReviewMessage
        ) {
            this.logger.warn({
                message: `Missing initialCommentData for PR#${pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        if (shouldGenerateOrUpdateSummary) {
            try {
                this.logger.log({
                    message: `Generating summary for PR#${pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        repository: context.repository,
                    },
                });

                // For REPLACE on commit runs, fetch the full PR diff (base...head)
                // so the LLM generates a complete summary, not just incremental.
                const useFullDiff =
                    isCommitRun &&
                    commitBehaviour === BehaviourForNewCommits.REPLACE;

                let changedFiles: Partial<FileChange>[];

                if (useFullDiff) {
                    const fullDiffFiles =
                        await this.pullRequestManagerService.getChangedFilesMetadata(
                            organizationAndTeamData,
                            repository,
                            pullRequest,
                        );
                    changedFiles = fullDiffFiles.map((file) => ({
                        filename: file.filename,
                        patch: file.patch,
                        status: file.status,
                    }));
                } else {
                    changedFiles = context.changedFiles.map((file) => ({
                        filename: file.filename,
                        patch: file.patch,
                        status: file.status,
                    }));
                }

                const summaryPR =
                    await this.commentManagerService.generateSummaryPR(
                        pullRequest,
                        repository,
                        changedFiles,
                        organizationAndTeamData,
                        codeReviewConfig.languageResultPrompt,
                        codeReviewConfig.summary,
                        codeReviewConfig?.byokConfig ?? null,
                        isCommitRun,
                        false,
                        context.externalPromptContext,
                        platformType,
                    );

                await this.commentManagerService.updateSummarizationInPR(
                    organizationAndTeamData,
                    pullRequest.number,
                    repository,
                    summaryPR,
                );
            } catch (error) {
                this.logger.error({
                    message: `Failed to generate summary for PR#${pullRequest.number}`,
                    context: this.stageName,
                    error,
                });

                const summaryError =
                    error instanceof Error ? error : new Error(String(error));

                // 'partial', not the 'critical' default: the review itself
                // still ran and its comments are on the PR — only the summary
                // is missing. Partial is enough to block auto-approve and to
                // land the check on NEUTRAL, which is the honest signal for
                // "degraded, not absent".
                const pipelineError: PipelineError = {
                    stage: this.stageName,
                    error: summaryError,
                    severity: 'partial',
                    metadata: {
                        message: 'Failed to generate summary',
                        reason: 'summary_generation_failed',
                    },
                };

                // Name the real cause in the PR comment ("provider returned
                // 404") instead of the generic "unexpected error" fallback.
                // Only fills the slot when no agent failure already claimed it
                // — a core-agent failure is the more important thing to report.
                const classification =
                    getClassification(summaryError) ??
                    classifyLLMError(
                        summaryError,
                        typeof codeReviewConfig?.byokConfig?.main?.provider ===
                            'string'
                            ? codeReviewConfig.byokConfig.main.provider
                            : undefined,
                    );

                // The pipeline context is Immer-frozen once an earlier stage
                // (e.g. agent-review) ran updateContext, so a direct
                // `context.errors = []` / `.push()` throws "Cannot assign to
                // read only property" — and here, INSIDE the summary-failure
                // catch, that throw would replace the real summary error with a
                // confusing frozen-mutation error and abort the stage. Record
                // the pipeline error through updateContext (same fix class as
                // create-file-comments #c886e369a / agent-review #1522).
                context = this.updateContext(context, (draft) => {
                    if (!draft.errors) {
                        draft.errors = [];
                    }
                    draft.errors.push(pipelineError);

                    if (!draft.lastReviewError) {
                        draft.lastReviewError = {
                            category: classification.category,
                            provider: classification.provider,
                            friendlyMessage: classification.friendlyMessage,
                            occurredAt: new Date(),
                        };
                    }
                });
            }
        }

        await this.postTraceComment(context);

        const { reviewFailed, reviewHasPartialErrors } =
            classifyErrors(context);
        const reviewErrorMessage = context.lastReviewError?.friendlyMessage;
        const reviewErrorCustomMessage = customMessageFor(reviewFailed);

        const startReviewMessage =
            context.pullRequestMessagesConfig?.startReviewMessage;
        const endReviewMessage =
            context.pullRequestMessagesConfig?.endReviewMessage;

        if (!endReviewMessage) {
            await this.commentManagerService.updateOverallComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                initialCommentData.commentId,
                initialCommentData.noteId,
                platformType,
                lineComments,
                codeReviewConfig,
                initialCommentData.threadId,
                undefined,
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
                reviewErrorCustomMessage,
                context.linkedRepositoriesMetadata,
            );
            return context;
        }

        if (
            endReviewMessage.status === PullRequestMessageStatus.OFF ||
            endReviewMessage.status === PullRequestMessageStatus.INACTIVE
        ) {
            return context;
        }

        if (
            endReviewMessage.status ===
                PullRequestMessageStatus.ONLY_WHEN_OPENED &&
            context.lastExecution
        ) {
            return context;
        }

        if (
            (endReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                endReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (endReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution)) &&
            startReviewMessage &&
            (startReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                startReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (startReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution))
        ) {
            const finalCommentBody =
                await this.commentManagerService.processEndReviewMessageTemplate(
                    endReviewMessage.content,
                    context.changedFiles,
                    organizationAndTeamData,
                    pullRequest.number,
                    codeReviewConfig,
                    codeReviewConfig?.languageResultPrompt ?? 'en-US',
                    platformType,
                    lineComments,
                );

            // Append cross-repo transparency line to custom end-review templates too.
            const linkedLine = formatLinkedReposSummaryLine(
                context.linkedRepositoriesMetadata,
            );
            const bodyWithLinked = linkedLine
                ? `${finalCommentBody}${linkedLine}`
                : finalCommentBody;

            await this.commentManagerService.updateOverallComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                initialCommentData.commentId,
                initialCommentData.noteId,
                platformType,
                lineComments,
                codeReviewConfig,
                initialCommentData.threadId,
                bodyWithLinked,
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
                reviewErrorCustomMessage,
                context.linkedRepositoriesMetadata,
            );
            return context;
        }

        if (
            (endReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                endReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (endReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution)) &&
            (!startReviewMessage ||
                startReviewMessage.status ===
                    PullRequestMessageStatus.INACTIVE ||
                startReviewMessage.status === PullRequestMessageStatus.OFF ||
                (startReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    context.lastExecution))
        ) {
            const finalCommentBody = endReviewMessage.content;

            await this.commentManagerService.createComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                platformType,
                context.changedFiles,
                context.codeReviewConfig?.languageResultPrompt ?? 'en-US',
                lineComments,
                codeReviewConfig,
                finalCommentBody,
                context.pullRequestMessagesConfig,
                context.prLevelCommentResults ?? [],
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
                reviewErrorCustomMessage,
            );
        }

        return context;
    }
}
