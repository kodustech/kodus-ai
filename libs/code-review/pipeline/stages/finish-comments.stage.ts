import { Injectable, Inject } from '@nestjs/common';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import {
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
    IPullRequestManagerService,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { createLogger } from '@kodus/flow';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    BehaviourForNewCommits,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';

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
    ) {
        super();
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
        const errors = context.errors ?? [];
        const reviewFailed = errors.some(
            (e) => (e?.severity ?? 'critical') === 'critical',
        );
        const reviewHasPartialErrors =
            !reviewFailed && errors.some((e) => e?.severity === 'partial');
        const reviewErrorMessage = context.lastReviewError?.friendlyMessage;

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
                    context.dryRun,
                );
            } catch (error) {
                this.logger.error({
                    message: `Failed to generate summary for PR#${pullRequest.number}`,
                    context: this.stageName,
                    error,
                });

                const pipelineError: PipelineError = {
                    stage: this.stageName,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        message: 'Failed to generate summary',
                        reason: 'summary_generation_failed',
                    },
                };

                if (!context.errors) {
                    context.errors = [];
                }
                context.errors.push(pipelineError);
            }
        }

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
                context.dryRun,
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
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
                );

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
                finalCommentBody,
                context.dryRun,
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
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
                context.dryRun,
                context.prLevelCommentResults ?? [],
                reviewFailed,
                reviewErrorMessage,
                reviewHasPartialErrors,
            );
        }

        return context;
    }
}
