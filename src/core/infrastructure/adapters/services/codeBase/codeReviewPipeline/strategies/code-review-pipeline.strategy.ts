/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Injectable } from '@nestjs/common';
import { IPipelineStrategy } from '../../../pipeline/interfaces/pipeline-strategy.interface';
import { ValidateConfigStage } from '../stages/validate-config.stage';
import { FetchChangedFilesStage } from '../stages/fetch-changed-files.stage';
import { InitialCommentStage } from '../stages/initial-comment.stage';
import { ProcessFilesReview } from '../stages/process-files-review.stage';
import { AggregateResultsStage } from '../stages/aggregate-result.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '../stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '../stages/finish-process-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';

@Injectable()
export class CodeReviewPipelineStrategy
    implements IPipelineStrategy<CodeReviewPipelineContext>
{
    constructor(
        private readonly validateConfigStage: ValidateConfigStage,
        private readonly fetchChangedFilesStage: FetchChangedFilesStage,
        private readonly initialCommentStage: InitialCommentStage,
        private readonly processFilesReview: ProcessFilesReview,
        private readonly aggregateResultsStage: AggregateResultsStage,
        private readonly updateCommentsAndGenerateSummaryStage: UpdateCommentsAndGenerateSummaryStage,
        private readonly requestChangesOrApproveStage: RequestChangesOrApproveStage,
    ) {}

    configureStages(): BasePipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.validateConfigStage,
            this.fetchChangedFilesStage,
            this.initialCommentStage,
            this.processFilesReview,
            this.aggregateResultsStage,
            this.updateCommentsAndGenerateSummaryStage,
            this.requestChangesOrApproveStage,
        ];
    }

    getPipelineName(): string {
        return 'CodeReviewPipeline';
    }
}
