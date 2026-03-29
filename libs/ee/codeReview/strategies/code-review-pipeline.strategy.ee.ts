/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Inject, Injectable } from '@nestjs/common';

import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { AggregateResultsStage } from '@libs/code-review/pipeline/stages/aggregate-result.stage';
import { CollectCrossFileContextStage } from '@libs/code-review/pipeline/stages/collect-cross-file-context.stage';
import {
    ILoadExternalContextStage,
    LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
} from '@libs/code-review/pipeline/stages/contracts/loadExternalContextStage.contract';
import { CreateFileCommentsStage } from '@libs/code-review/pipeline/stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from '@libs/code-review/pipeline/stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from '@libs/code-review/pipeline/stages/fetch-changed-files.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '@libs/code-review/pipeline/stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '@libs/code-review/pipeline/stages/finish-process-review.stage';
import { GatherDocumentationContextStage } from '@libs/code-review/pipeline/stages/gather-documentation-context.stage';
import { InitialCommentStage } from '@libs/code-review/pipeline/stages/initial-comment.stage';
import { ProcessFilesReview } from '@libs/code-review/pipeline/stages/process-files-review.stage';
import { ValidateConfigStage } from '@libs/code-review/pipeline/stages/validate-config.stage';
import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';

import { CodeAnalysisASTCleanupStage } from '../stages/code-analysis-ast-cleanup.stage';
import { CodeAnalysisASTStage } from '../stages/code-analysis-ast.stage';
import { KodyFineTuningStage } from '../stages/kody-fine-tuning.stage';

import { FileContextGateStage } from '@libs/code-review/pipeline/stages/file-context-gate.stage';
import { ProcessFilesPrLevelReviewStage } from '@libs/code-review/pipeline/stages/process-files-pr-level-review.stage';
import { ResolveConfigStage } from '@libs/code-review/pipeline/stages/resolve-config.stage';
import { ValidateNewCommitsStage } from '@libs/code-review/pipeline/stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from '@libs/code-review/pipeline/stages/validate-prerequisites.stage';
import { ValidateSuggestionsStage } from '@libs/code-review/pipeline/stages/validate-suggestions.stage';

@Injectable()
export class CodeReviewPipelineStrategyEE implements IPipelineStrategy<CodeReviewPipelineContext> {
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
        private readonly kodyFineTuningStage: KodyFineTuningStage,
        private readonly codeAnalysisASTStage: CodeAnalysisASTStage,
        private readonly processFilesPrLevelReviewStage: ProcessFilesPrLevelReviewStage,
        private readonly processFilesReview: ProcessFilesReview,
        private readonly createPrLevelCommentsStage: CreatePrLevelCommentsStage,
        private readonly createFileCommentsStage: CreateFileCommentsStage,
        private readonly codeAnalysisASTCleanupStage: CodeAnalysisASTCleanupStage,
        private readonly aggregateResultsStage: AggregateResultsStage,
        private readonly updateCommentsAndGenerateSummaryStage: UpdateCommentsAndGenerateSummaryStage,
        private readonly requestChangesOrApproveStage: RequestChangesOrApproveStage,
        private readonly validateSuggestionsStage: ValidateSuggestionsStage,
    ) {}

    getPipelineName(): string {
        return 'CodeReviewPipeline';
    }

    configureStages(): PipelineStage<CodeReviewPipelineContext>[] {
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
            this.kodyFineTuningStage,
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
}
