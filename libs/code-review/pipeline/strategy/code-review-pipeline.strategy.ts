/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ValidateConfigStage } from '../stages/validate-config.stage';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { AggregateResultsStage } from '../stages/aggregate-result.stage';
import { CollectCrossFileContextStage } from '../stages/collect-cross-file-context.stage';
import {
    ILoadExternalContextStage,
    LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
} from '../stages/contracts/loadExternalContextStage.contract';
import { CreateFileCommentsStage } from '../stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from '../stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from '../stages/fetch-changed-files.stage';
import { FileContextGateStage } from '../stages/file-context-gate.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '../stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '../stages/finish-process-review.stage';
import { GatherDocumentationContextStage } from '../stages/gather-documentation-context.stage';
import { InitialCommentStage } from '../stages/initial-comment.stage';
import { ProcessFilesPrLevelReviewStage } from '../stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from '../stages/process-files-review.stage';
import { ResolveConfigStage } from '../stages/resolve-config.stage';
import { ValidateNewCommitsStage } from '../stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from '../stages/validate-prerequisites.stage';
import { ValidateSuggestionsStage } from '../stages/validate-suggestions.stage';

@Injectable()
export class CodeReviewPipelineStrategy implements IPipelineStrategy<CodeReviewPipelineContext> {
    constructor(
        private readonly validatePrerequisitesStage: ValidatePrerequisitesStage,
        private readonly validateNewCommitsStage: ValidateNewCommitsStage,
        private readonly resolveConfigStage: ResolveConfigStage,
        private readonly validateConfigStage: ValidateConfigStage,
        private readonly fetchChangedFilesStage: FetchChangedFilesStage,
        private readonly gatherDocumentationContextStage: GatherDocumentationContextStage,
        @Inject(LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN)
        private readonly loadExternalContextStage: ILoadExternalContextStage,
        private readonly fileContextGateStage: FileContextGateStage,
        private readonly initialCommentStage: InitialCommentStage,
        private readonly collectCrossFileContextStage: CollectCrossFileContextStage,
        private readonly processFilesPrLevelReviewStage: ProcessFilesPrLevelReviewStage,
        private readonly processFilesReview: ProcessFilesReview,
        private readonly createPrLevelCommentsStage: CreatePrLevelCommentsStage,
        private readonly createFileCommentsStage: CreateFileCommentsStage,
        private readonly aggregateResultsStage: AggregateResultsStage,
        private readonly updateCommentsAndGenerateSummaryStage: UpdateCommentsAndGenerateSummaryStage,
        private readonly requestChangesOrApproveStage: RequestChangesOrApproveStage,
        private readonly validateSuggestionsStage: ValidateSuggestionsStage,
    ) {}

    configureStages(): BasePipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.validatePrerequisitesStage,
            this.validateNewCommitsStage,
            this.resolveConfigStage,
            this.validateConfigStage,
            this.fetchChangedFilesStage,
            this.gatherDocumentationContextStage,
            this.loadExternalContextStage,
            this.fileContextGateStage,
            this.initialCommentStage,
            this.collectCrossFileContextStage,
            this.processFilesPrLevelReviewStage,
            this.processFilesReview,
            this.createPrLevelCommentsStage,
            this.validateSuggestionsStage,
            this.createFileCommentsStage,
            this.aggregateResultsStage,
            this.updateCommentsAndGenerateSummaryStage,
            this.requestChangesOrApproveStage,
        ];
    }

    getPipelineName(): string {
        return 'CodeReviewPipeline';
    }
}
