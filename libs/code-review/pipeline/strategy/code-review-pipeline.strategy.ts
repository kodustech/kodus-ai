/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Inject, Injectable } from '@nestjs/common';

import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { AggregateResultsStage } from '../stages/aggregate-result.stage';
import { AgentReviewStage } from '../stages/agent-review.stage';
import { BusinessLogicValidationStage } from '../stages/business-logic-validation.stage';
import {
    ILoadExternalContextStage,
    LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
} from '../stages/contracts/loadExternalContextStage.contract';
import { CreateFileCommentsStage } from '../stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from '../stages/create-pr-level-comments.stage';
import { CreateSandboxStage } from '../stages/create-sandbox.stage';
import { FetchChangedFilesStage } from '../stages/fetch-changed-files.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '../stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '../stages/finish-process-review.stage';
import { InitialCommentStage } from '../stages/initial-comment.stage';
import { ResolveConfigStage } from '../stages/resolve-config.stage';
import { ValidateConfigStage } from '../stages/validate-config.stage';
import { ValidateNewCommitsStage } from '../stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from '../stages/validate-prerequisites.stage';
import { ValidateSuggestionsStage } from '../stages/validate-suggestions.stage';

/**
 * Code review pipeline (agent engine only). The stage list is linear:
 *
 *   sharedEarly → agent (businessLogic → sandbox → agentReview) → sharedPost
 *
 * The former EE engine and the SelectReviewEngineStage gate that skipped one
 * branch were removed once every repo moved to the agent engine — there is no
 * longer anything to select or skip.
 */
@Injectable()
export class CodeReviewPipelineStrategy implements IPipelineStrategy<CodeReviewPipelineContext> {
    constructor(
        private readonly validatePrerequisitesStage: ValidatePrerequisitesStage,
        private readonly validateNewCommitsStage: ValidateNewCommitsStage,
        private readonly resolveConfigStage: ResolveConfigStage,
        private readonly validateConfigStage: ValidateConfigStage,
        private readonly fetchChangedFilesStage: FetchChangedFilesStage,
        @Inject(LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN)
        private readonly loadExternalContextStage: ILoadExternalContextStage,
        private readonly initialCommentStage: InitialCommentStage,
        private readonly businessLogicValidationStage: BusinessLogicValidationStage,
        private readonly createSandboxStage: CreateSandboxStage,
        private readonly agentReviewStage: AgentReviewStage,
        private readonly createPrLevelCommentsStage: CreatePrLevelCommentsStage,
        private readonly validateSuggestionsStage: ValidateSuggestionsStage,
        private readonly createFileCommentsStage: CreateFileCommentsStage,
        private readonly aggregateResultsStage: AggregateResultsStage,
        private readonly updateCommentsAndGenerateSummaryStage: UpdateCommentsAndGenerateSummaryStage,
        private readonly requestChangesOrApproveStage: RequestChangesOrApproveStage,
    ) {}

    getPipelineName(): string {
        return 'CodeReviewPipeline';
    }

    configureStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            ...this.sharedEarlyStages(),
            // Agent is the only engine now: no branch, no engine-selection gate.
            this.businessLogicValidationStage,
            this.createSandboxStage,
            this.agentReviewStage,
            ...this.sharedPostStages(),
        ];
    }

    /**
     * here (after config is resolved, before file fetching reads
     * the "review starting" comment before either branch executes.
     */
    private sharedEarlyStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.validatePrerequisitesStage,
            this.validateNewCommitsStage,
            this.resolveConfigStage,
            this.validateConfigStage,
            this.fetchChangedFilesStage,
            this.loadExternalContextStage,
            this.initialCommentStage,
        ];
    }

    /** Shared post-processing — runs for every PR. */
    private sharedPostStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.createPrLevelCommentsStage,
            this.validateSuggestionsStage,
            this.createFileCommentsStage,
            this.aggregateResultsStage,
            this.updateCommentsAndGenerateSummaryStage,
            this.requestChangesOrApproveStage,
        ];
    }
}
