import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class InitialCommentStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'InitialCommentStage';

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private commentManagerService: ICommentManagerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const lastExecution = context.lastExecution;

        if (lastExecution?.commentId && lastExecution?.noteId) {
            // TALVEZ FALTE PARTE DE LOG loginfo
            return this.updateContext(context, (draft) => {
                draft.initialCommentData = {
                    commentId: lastExecution.commentId,
                    noteId: lastExecution.noteId,
                };
            });
        }

        const result = await this.commentManagerService.createInitialComment(
            context.organizationAndTeamData,
            context.pullRequest.number,
            context.repository,
            context.changedFiles,
            context.codeReviewConfig.languageResultPrompt,
            context.platformType,
        );

        return this.updateContext(context, (draft) => {
            draft.initialCommentData = result;
        });
    }
}
