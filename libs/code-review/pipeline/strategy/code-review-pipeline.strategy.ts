/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Inject, Injectable } from '@nestjs/common';

import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { PipelineStage } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';
import { KodyFineTuningStage } from '@libs/ee/codeReview/stages/kody-fine-tuning.stage';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { AggregateResultsStage } from '../stages/aggregate-result.stage';
import { AgentReviewStage } from '../stages/agent-review.stage';
import { BusinessLogicValidationStage } from '../stages/business-logic-validation.stage';
import { CollectCrossFileContextStage } from '../stages/collect-cross-file-context.stage';
import {
    ILoadExternalContextStage,
    LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
} from '../stages/contracts/loadExternalContextStage.contract';
import { CreateFileCommentsStage } from '../stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from '../stages/create-pr-level-comments.stage';
import { CreateSandboxStage } from '../stages/create-sandbox.stage';
import { FetchChangedFilesStage } from '../stages/fetch-changed-files.stage';
import { FileContextGateStage } from '../stages/file-context-gate.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '../stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '../stages/finish-process-review.stage';
import { InitialCommentStage } from '../stages/initial-comment.stage';
import { ProcessFilesPrLevelReviewStage } from '../stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from '../stages/process-files-review.stage';
import { ResolveConfigStage } from '../stages/resolve-config.stage';
import { SelectReviewEngineStage } from '../stages/select-review-engine.stage';
import { ValidateConfigStage } from '../stages/validate-config.stage';
import { ValidateNewCommitsStage } from '../stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from '../stages/validate-prerequisites.stage';
import { ValidateSuggestionsStage } from '../stages/validate-suggestions.stage';

/**
 * Unified code review pipeline. The stage list assembles four groups:
 *
 *   sharedEarly → eeBranch → agentBranch → sharedPost
 *
 * `SelectReviewEngineStage` (inside `sharedEarly`) decides which engine
 * wins for this PR and calls `skipStages([...])` with the names of the
 * losing branch. Branch stage *names* live in
 * `engine-branches.const.ts` so the gate's skip list and this strategy's
 * grouping stay in sync — see `code-review-pipeline.strategy.spec.ts`
 * for the consistency assertion.
 */
@Injectable()
export class CodeReviewPipelineStrategy
    implements IPipelineStrategy<CodeReviewPipelineContext>
{
    constructor(
        private readonly validatePrerequisitesStage: ValidatePrerequisitesStage,
        private readonly validateNewCommitsStage: ValidateNewCommitsStage,
        private readonly resolveConfigStage: ResolveConfigStage,
        private readonly selectReviewEngineStage: SelectReviewEngineStage,
        private readonly validateConfigStage: ValidateConfigStage,
        private readonly fetchChangedFilesStage: FetchChangedFilesStage,
        @Inject(LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN)
        private readonly loadExternalContextStage: ILoadExternalContextStage,
        private readonly initialCommentStage: InitialCommentStage,
        private readonly fileContextGateStage: FileContextGateStage,
        private readonly collectCrossFileContextStage: CollectCrossFileContextStage,
        private readonly kodyFineTuningStage: KodyFineTuningStage,
        private readonly processFilesPrLevelReviewStage: ProcessFilesPrLevelReviewStage,
        private readonly processFilesReview: ProcessFilesReview,
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
            ...this.eeBranchStages(),
            ...this.agentBranchStages(),
            ...this.sharedPostStages(),
        ];
    }

    /**
     * Shared prep — runs for every PR. `SelectReviewEngineStage` sits
     * here (after config is resolved, before file fetching reads
     * `useAgentEngine` for its size limit). `InitialCommentStage` posts
     * the "review starting" comment before either branch executes.
     */
    private sharedEarlyStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.validatePrerequisitesStage,
            this.validateNewCommitsStage,
            this.resolveConfigStage,
            this.selectReviewEngineStage,
            this.validateConfigStage,
            this.fetchChangedFilesStage,
            this.loadExternalContextStage,
            this.initialCommentStage,
        ];
    }

    /**
     * EE engine core — bypassed when agent is selected. Names must match
     * `EE_BRANCH_STAGE_NAMES`; the consistency test enforces this.
     */
    eeBranchStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.fileContextGateStage,
            this.collectCrossFileContextStage,
            this.kodyFineTuningStage,
            this.processFilesPrLevelReviewStage,
            this.processFilesReview,
        ];
    }

    /**
     * Agent engine core — bypassed when EE is selected. Names must match
     * `AGENT_BRANCH_STAGE_NAMES`; the consistency test enforces this.
     */
    agentBranchStages(): PipelineStage<CodeReviewPipelineContext>[] {
        return [
            this.businessLogicValidationStage,
            this.createSandboxStage,
            this.agentReviewStage,
        ];
    }

    /** Shared post-processing — runs for every PR regardless of branch. */
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
