/**
 * @license
 * © Kodus Tech. All rights reserved.
 */
import { Module, forwardRef } from '@nestjs/common';
import { PipelineExecutor } from '@/core/infrastructure/adapters/services/pipeline/pipeline-executor.service';

import { ValidateConfigStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/validate-config.stage';
import { FetchChangedFilesStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/fetch-changed-files.stage';
import { InitialCommentStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/initial-comment.stage';
import { BatchCreationStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/create-batch.stage';
import { ProcessFilesReview } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/process-files-review.stage';
import { AggregateResultsStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/aggregate-result.stage';
import { UpdateCommentsAndGenerateSummaryStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/finish-process-review.stage';

import { ParametersModule } from './parameters.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { AutomationModule } from './automation.module';
import { PullRequestsModule } from './pullRequests.module';
import { AstModule } from './ast.module';
import { KodyRulesModule } from './kodyRules.module';
import { SuggestionEmbeddedModule } from './suggestionEmbedded.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { FileReviewModule } from '@/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { CodebaseModule } from './codeBase.module';
import { CodeReviewPipelineStrategy } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/strategies/code-review-pipeline.strategy';
import { CodeReviewPipelineStrategyEE } from '@/ee/codeReview/strategies/code-review-pipeline.strategy.ee';
import { KodyFineTuningStage } from '@/ee/codeReview/stages/kody-fine-tuning.stage';
import { CodeAnalysisASTStage } from '@/ee/codeReview/stages/code-analysis-ast.stage';
import { KodyFineTuningContextModule } from '@/ee/kodyFineTuning/fineTuningContext/kodyFineTuningContext.module';
import { KodyASTAnalyzeContextModule } from '@/ee/kodyASTAnalyze/kodyAstAnalyzeContext.module';

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => AstModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => SuggestionEmbeddedModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => KodyASTAnalyzeContextModule),
    ],
    providers: [
        PipelineExecutor,
        CodeReviewPipelineStrategy,
        CodeReviewPipelineStrategyEE,
        // Stages
        ValidateConfigStage,
        FetchChangedFilesStage,
        InitialCommentStage,
        BatchCreationStage,
        ProcessFilesReview,
        AggregateResultsStage,
        UpdateCommentsAndGenerateSummaryStage,
        RequestChangesOrApproveStage,
        KodyFineTuningStage,
        CodeAnalysisASTStage,
    ],
    exports: [
        PipelineExecutor,
        ValidateConfigStage,
        FetchChangedFilesStage,
        InitialCommentStage,
        BatchCreationStage,
        ProcessFilesReview,
        KodyFineTuningStage,
        CodeAnalysisASTStage,
        AggregateResultsStage,
        UpdateCommentsAndGenerateSummaryStage,
        RequestChangesOrApproveStage,
        CodeReviewPipelineStrategy,
        CodeReviewPipelineStrategyEE,
    ],
})
export class CodeReviewPipelineModule { }
