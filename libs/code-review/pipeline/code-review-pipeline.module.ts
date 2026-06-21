import { CloneParamsResolverService } from './services/clone-params-resolver.service';
import { Module, forwardRef } from '@nestjs/common';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';

// Stages
import { AggregateResultsStage } from './stages/aggregate-result.stage';
import { CollectCrossFileContextStage } from './stages/collect-cross-file-context.stage';
import { CreateFileCommentsStage } from './stages/create-file-comments.stage';
import { CreatePrLevelCommentsStage } from './stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from './stages/fetch-changed-files.stage';
import { FileContextGateStage } from './stages/file-context-gate.stage';
import { UpdateCommentsAndGenerateSummaryStage } from './stages/finish-comments.stage';
import { NotificationModule } from '@libs/notifications/modules/notification.module';
import { UserCoreModule } from '@libs/identity/modules/user-core.module';

import { RequestChangesOrApproveStage } from './stages/finish-process-review.stage';
import { GatherDocumentationContextStage } from './stages/gather-documentation-context.stage';
import { InitialCommentStage } from './stages/initial-comment.stage';
import { LoadExternalContextStage } from './stages/load-external-context.stage';
import { ProcessFilesPrLevelReviewStage } from './stages/process-files-pr-level-review.stage';
import { BusinessLogicValidationStage } from './stages/business-logic-validation.stage';
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
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { DryRunCoreModule } from '@libs/dryRun/dry-run-core.module';
import { FileReviewModule } from '@libs/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { KodyFineTuningStage } from '@libs/ee/codeReview/stages/kody-fine-tuning.stage';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { KodyFineTuningContextModule } from '@libs/kodyFineTuning/kodyFineTuningContext.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { GithubModule } from '@libs/platform/modules/github.module';
import { ForgejoChecksService } from '@libs/platform/infrastructure/adapters/services/forgejo/forgejo-checks.service';
import { ForgejoModule } from '@libs/platform/modules/forgejo.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { SandboxSyntaxValidator } from '../infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { GraphContentFormatter } from '../infrastructure/adapters/services/graphContentFormatter.service';
import { SuggestionLLMValidator } from '../infrastructure/adapters/services/suggestionLLMValidator.service';
import { CodeReviewPipelineObserver } from '../infrastructure/observers/code-review-pipeline.observer';
import { AstGraphModule } from '../modules/ast-graph.module';
import { CodebaseModule } from '../modules/codebase.module';
import { DocumentationContextModule } from '../modules/documentation-context.module';
import { PullRequestsModule } from '../modules/pull-requests.module';
import { PullRequestMessagesModule } from '../modules/pullRequestMessages.module';
import { CodeReviewJobProcessorService } from '../workflow/code-review-job-processor.service';
import { ByokConcurrencyGateService } from '../workflow/byok-concurrency-gate.service';
import { GitHubRateLimitGateService } from '@libs/platform/infrastructure/adapters/services/github/github-rate-limit-gate.service';
import { RATE_LIMIT_GATE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/rate-limit-gate.service.contract';
import { ImplementationVerificationProcessor } from '../workflow/implementation-verification.processor';
import { LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN } from './stages/contracts/loadExternalContextStage.contract';
import { ValidateSuggestionsStage } from './stages/validate-suggestions.stage';
import { CodeReviewPipelineStrategy } from './strategy/code-review-pipeline.strategy';
import { SelectReviewEngineStage } from './stages/select-review-engine.stage';

// Sandbox (lease manager)
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';

// V3 Agent-First
import { CreateSandboxStage } from './stages/create-sandbox.stage';
import { AgentReviewStage } from './stages/agent-review.stage';
import { BugAgentProvider } from '../infrastructure/agents/bug-agent.provider';
import { SecurityAgentProvider } from '../infrastructure/agents/security-agent.provider';
import { PerformanceAgentProvider } from '../infrastructure/agents/performance-agent.provider';
import { GeneralistAgentProvider } from '../infrastructure/agents/generalist-agent.provider';
import { KodyRulesAgentProvider } from '../infrastructure/agents/kody-rules-agent.provider';
// ReflectionAgentProvider removed — verify/discover was hurting recall
import { ReviewOrchestratorService } from '../infrastructure/agents/review-orchestrator.service';

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
        forwardRef(() => DocumentationContextModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => AgentsModule),
        forwardRef(() => AIEngineModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => GithubModule),
        forwardRef(() => ForgejoModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => LicenseModule),
        AstGraphModule,
        forwardRef(() => McpCoreModule),
        WorkflowCoreModule,
        DryRunCoreModule,
        SandboxModule,
        NotificationModule,
        UserCoreModule,
    ],
    providers: [
        // Strategy
        CodeReviewPipelineStrategy,

        // Job Processor
        CodeReviewJobProcessorService,
        ByokConcurrencyGateService,
        DistributedLockService,
        // GitHub rate-limit gate — pre-check before burning slot on a
        // job whose installation bucket is already exhausted. Same
        // instance shared via both the token (for processors that
        // inject by abstraction) and the concrete class (for any
        // direct consumer).
        GitHubRateLimitGateService,
        {
            provide: RATE_LIMIT_GATE_SERVICE_TOKEN,
            useExisting: GitHubRateLimitGateService,
        },

        // Services
        CloneParamsResolverService,

        // Stages
        ValidateNewCommitsStage,
        ValidatePrerequisitesStage,
        ResolveConfigStage,
        SelectReviewEngineStage,
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
        BusinessLogicValidationStage,
        ProcessFilesReview,
        SandboxSyntaxValidator,
        GraphContentFormatter,
        SuggestionLLMValidator,
        CreatePrLevelCommentsStage,
        CreateFileCommentsStage,
        AggregateResultsStage,
        UpdateCommentsAndGenerateSummaryStage,
        RequestChangesOrApproveStage,
        ValidateSuggestionsStage,

        // V3 Agent-First stages + providers
        CreateSandboxStage,
        AgentReviewStage,
        BugAgentProvider,
        SecurityAgentProvider,
        PerformanceAgentProvider,
        GeneralistAgentProvider,
        KodyRulesAgentProvider,
        // ReflectionAgentProvider removed
        ReviewOrchestratorService,

        // EE Stages
        KodyFineTuningStage,

        // For GitHub Checks
        GithubChecksService,
        ForgejoChecksService,
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
        CodeReviewPipelineStrategy,

        CodeReviewJobProcessorService,
        CodeReviewPipelineObserver,
        // Export stages if needed by tests or other modules
        CreateFileCommentsStage,
        CreatePrLevelCommentsStage,
        UpdateCommentsAndGenerateSummaryStage,
        ProcessFilesPrLevelReviewStage,
        BusinessLogicValidationStage,
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
        // V3
        CreateSandboxStage,
        AgentReviewStage,
        ReviewOrchestratorService,
    ],
})
export class CodeReviewPipelineModule {}
