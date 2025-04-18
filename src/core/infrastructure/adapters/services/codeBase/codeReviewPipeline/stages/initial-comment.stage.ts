import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

@Injectable()
export class InitialCommentStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'InitialCommentStage';

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private commentManagerService: ICommentManagerService,
        private readonly logger: PinoLoggerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
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
