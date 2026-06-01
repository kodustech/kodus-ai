import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { AggregateResultsStage } from '@libs/code-review/pipeline/stages/aggregate-result.stage';
import {
    ILoadExternalContextStage,
    LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
} from '@libs/code-review/pipeline/stages/contracts/loadExternalContextStage.contract';
import { CreateFileCommentsStage } from '@libs/code-review/pipeline/stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from '@libs/code-review/pipeline/stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from '@libs/code-review/pipeline/stages/fetch-changed-files.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '@libs/code-review/pipeline/stages/finish-comments.stage';
import { InitialCommentStage } from '@libs/code-review/pipeline/stages/initial-comment.stage';
import { ProcessFilesPrLevelReviewStage } from '@libs/code-review/pipeline/stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from '@libs/code-review/pipeline/stages/process-files-review.stage';
import { ResolveConfigStage } from '@libs/code-review/pipeline/stages/resolve-config.stage';
import { ValidateConfigStage } from '@libs/code-review/pipeline/stages/validate-config.stage';
import { ValidateSuggestionsStage } from '@libs/code-review/pipeline/stages/validate-suggestions.stage';
import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class DryRunCodeReviewPipelineStrategy implements IPipelineStrategy<CodeReviewPipelineContext> {
    constructor(
        private readonly resolveConfigStage: ResolveConfigStage,
        private readonly validateConfigStage: ValidateConfigStage,
        private readonly fetchChangedFilesStage: FetchChangedFilesStage,
        @Inject(LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN)
        private readonly loadExternalContextStage: ILoadExternalContextStage,
        private readonly initialCommentStage: InitialCommentStage,
        private readonly processFilesPrLevelReviewStage: ProcessFilesPrLevelReviewStage,
        private readonly processFilesReview: ProcessFilesReview,
        private readonly createPrLevelCommentsStage: CreatePrLevelCommentsStage,
        private readonly createFileCommentsStage: CreateFileCommentsStage,
        private readonly aggregateResultsStage: AggregateResultsStage,
        private readonly updateCommentsAndGenerateSummaryStage: UpdateCommentsAndGenerateSummaryStage,
        private readonly validateSuggestionsStage: ValidateSuggestionsStage,
    ) {}

    configureStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.resolveConfigStage,
            this.validateConfigStage,
            this.fetchChangedFilesStage,
            // GatherDocumentationContextStage retired 2026-05-13.
            this.loadExternalContextStage,
            this.initialCommentStage,
            this.processFilesPrLevelReviewStage,
            this.processFilesReview,
            this.createPrLevelCommentsStage,
            this.validateSuggestionsStage,
            this.createFileCommentsStage,
            this.aggregateResultsStage,
            this.updateCommentsAndGenerateSummaryStage,
        ];
    }

    getPipelineName(): string {
        return 'DryRunCodeReviewPipeline';
    }
}
