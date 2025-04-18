import { Injectable, Inject } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { PinoLoggerService } from '../../../logger/pino.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class UpdateCommentsAndGenerateSummaryStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'UpdateCommentsAndGenerateSummaryStage';

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,
        private readonly logger: PinoLoggerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const {
            lastExecution,
            codeReviewConfig,
            overallComments,
            repository,
            pullRequest,
            organizationAndTeamData,
            platformType,
            initialCommentData,
            lineComments,
        } = context;

        if (!initialCommentData) {
            this.logger.warn({
                message: `Missing initialCommentData for PR#${pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        if (!lastExecution && codeReviewConfig.summary.generatePRSummary) {
            this.logger.log({
                message: `Generating summary for PR#${pullRequest.number}`,
                context: this.stageName,
            });

            const summaryPR =
                await this.commentManagerService.generateSummaryPR(
                    pullRequest,
                    repository,
                    overallComments,
                    organizationAndTeamData,
                    codeReviewConfig.languageResultPrompt,
                    codeReviewConfig.summary,
                );

            await this.commentManagerService.updateSummarizationInPR(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                summaryPR,
            );
        }

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
        );

        return context;
    }
}
