import { Module, forwardRef } from '@nestjs/common';

// Stages
import { AggregateResultsStage } from './stages/aggregate-result.stage';
import { CollectCrossFileContextStage } from './stages/collect-cross-file-context.stage';
import { CreateFileCommentsStage } from './stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from './stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from './stages/fetch-changed-files.stage';
import { FileContextGateStage } from './stages/file-context-gate.stage';
import { UpdateCommentsAndGenerateSummaryStage } from './stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from './stages/finish-process-review.stage';
import { GatherDocumentationContextStage } from './stages/gather-documentation-context.stage';
import { InitialCommentStage } from './stages/initial-comment.stage';
import { LoadExternalContextStage } from './stages/load-external-context.stage';
import { ProcessFilesPrLevelReviewStage } from './stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from './stages/process-files-review.stage';
import { ResolveConfigStage } from './stages/resolve-config.stage';
import { ValidateConfigStage } from './stages/validate-config.stage';
import { ValidateNewCommitsStage } from './stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from './stages/validate-prerequisites.stage';

// EE Stages

// Interfaces
import { AgentsModule } from '@libs/agents/modules/agents.module';
import { AIEngineModule } from '@libs/ai-engine/modules/ai-engine.module';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { PIPELINE_CHECKS_SERVICE_TOKEN } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { NullChecksAdapter } from '@libs/core/infrastructure/pipeline/services/null-checks.adapter';
import { PipelineChecksService } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { WorkflowCoreModule } from '@libs/core/workflow/modules/workflow-core.module';
import { DryRunCoreModule } from '@libs/dryRun/dry-run-core.module';
import { FileReviewModule } from '@libs/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { CodeAnalysisASTCleanupStage } from '@libs/ee/codeReview/stages/code-analysis-ast-cleanup.stage';
import { CodeAnalysisASTStage } from '@libs/ee/codeReview/stages/code-analysis-ast.stage';
import { KodyFineTuningStage } from '@libs/ee/codeReview/stages/kody-fine-tuning.stage';
import { CodeReviewPipelineStrategyEE } from '@libs/ee/codeReview/strategies/code-review-pipeline.strategy.ee';
import { KodyASTModule } from '@libs/ee/kodyAST/kodyAST.module';
import { KodyASTAnalyzeContextModule } from '@libs/ee/kodyASTAnalyze/kodyAstAnalyzeContext.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { KodyFineTuningContextModule } from '@libs/kodyFineTuning/kodyFineTuningContext.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { ASTContentFormatterService } from '../infrastructure/adapters/services/astContentFormatter.service';
import { CodeReviewPipelineObserver } from '../infrastructure/observers/code-review-pipeline.observer';
import { CodebaseModule } from '../modules/codebase.module';
import { DocumentationContextModule } from '../modules/documentation-context.module';
import { PullRequestsModule } from '../modules/pull-requests.module';
import { PullRequestMessagesModule } from '../modules/pullRequestMessages.module';
import { CodeReviewJobProcessorService } from '../workflow/code-review-job-processor.service';
import { ImplementationVerificationProcessor } from '../workflow/implementation-verification.processor';
import { LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN } from './stages/contracts/loadExternalContextStage.contract';
import { ValidateSuggestionsStage } from './stages/validate-suggestions.stage';
import { CodeReviewPipelineStrategy } from './strategy/code-review-pipeline.strategy';

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
        forwardRef(() => DocumentationContextModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => AgentsModule),
        forwardRef(() => AIEngineModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => KodyASTAnalyzeContextModule),
        forwardRef(() => KodyASTModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => GithubModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => LicenseModule),
        WorkflowCoreModule,
        DryRunCoreModule,
    ],
    providers: [
        // Strategy
        CodeReviewPipelineStrategyEE,
        CodeReviewPipelineStrategy,

        // Job Processor
        CodeReviewJobProcessorService,

        // Stages
        ValidateNewCommitsStage,
        ValidatePrerequisitesStage,
        ResolveConfigStage,
        ValidateConfigStage,
        FetchChangedFilesStage,
        {
            provide: LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
            useExisting: LoadExternalContextStage,
        },
        LoadExternalContextStage,
        GatherDocumentationContextStage,
        FileContextGateStage,
        InitialCommentStage,
        CollectCrossFileContextStage,
        ProcessFilesPrLevelReviewStage,
        ProcessFilesReview,
        ASTContentFormatterService,
        CreatePrLevelCommentsStage,
        CreateFileCommentsStage,
        AggregateResultsStage,
        UpdateCommentsAndGenerateSummaryStage,
        RequestChangesOrApproveStage,
        ValidateSuggestionsStage,

        // EE Stages
        KodyFineTuningStage,
        CodeAnalysisASTStage,
        CodeAnalysisASTCleanupStage,

        // For GitHub Checks
        GithubChecksService,
        NullChecksAdapter,
        ChecksAdapterFactory,
        {
            provide: PIPELINE_CHECKS_SERVICE_TOKEN,
            useClass: PipelineChecksService,
        },

        // Implementation Verification
        ImplementationVerificationProcessor,

        // Observers
        CodeReviewPipelineObserver,
    ],
    exports: [
        CodeReviewPipelineStrategyEE,
        CodeReviewPipelineStrategy,
        CodeReviewJobProcessorService,
        CodeReviewPipelineObserver,
        // Export stages if needed by tests or other modules
        CreateFileCommentsStage,
        CreatePrLevelCommentsStage,
        UpdateCommentsAndGenerateSummaryStage,
        ProcessFilesPrLevelReviewStage,
        ProcessFilesReview,
        ResolveConfigStage,
        ValidateConfigStage,
        ValidateNewCommitsStage,
        ValidatePrerequisitesStage,
        FetchChangedFilesStage,
        InitialCommentStage,
        CollectCrossFileContextStage,
        GatherDocumentationContextStage,
        AggregateResultsStage,
        LoadExternalContextStage,
        LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
        ValidateSuggestionsStage,
        ImplementationVerificationProcessor,
    ],
})
export class CodeReviewPipelineModule {}
