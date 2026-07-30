import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

// Pipeline
import { FormatCliOutputStage } from './pipeline/stages/format-cli-output.stage';
import { PrepareCliFilesStage } from './pipeline/stages/prepare-cli-files.stage';
import { CliReviewPipelineStrategy } from './pipeline/strategy/cli-review-pipeline.strategy';

// Use Cases
import { ClassifyCliSessionCaptureUseCase } from './application/use-cases/classify-cli-session-capture.use-case';
import { ClassifySessionUseCase } from './application/use-cases/classify-session.use-case';
import { EnqueueCliReviewUseCase } from './application/use-cases/enqueue-cli-review.use-case';
import { PublicPrReviewUseCase } from './application/use-cases/public-pr-review.use-case';
import { ListFeaturedPublicReviewsUseCase } from './application/use-cases/list-featured-public-reviews.use-case';
import { GetFeaturedPublicReviewUseCase } from './application/use-cases/get-featured-public-review.use-case';
import { ValidateCliKeyUseCase } from './application/use-cases/validate-cli-key.use-case';
import { ExecuteCliReviewUseCase } from './application/use-cases/execute-cli-review.use-case';
import { GetCliReviewByIdUseCase } from './application/use-cases/dashboard/get-cli-review-by-id.use-case';
import { GetCliReviewsUseCase } from './application/use-cases/dashboard/get-cli-reviews.use-case';
import { GetCliReviewJobStatusUseCase } from './application/use-cases/get-cli-review-job-status.use-case';
import { IngestSessionEventUseCase } from './application/use-cases/ingest-session-event.use-case';
import { SubmitCliSessionCaptureUseCase } from './application/use-cases/submit-cli-session-capture.use-case';
import { WaitForCliReviewJobUseCase } from './application/use-cases/wait-for-cli-review-job.use-case';

// Workflow
import { CliReviewJobProcessorService } from './workflow/cli-review-job-processor.service';
import { GitHubRateLimitGateService } from '@libs/platform/infrastructure/adapters/services/github/github-rate-limit-gate.service';
import { RATE_LIMIT_GATE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/rate-limit-gate.service.contract';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';

// Services
import { CliInputConverter } from './infrastructure/converters/cli-input.converter';
import { CliSessionCaptureRepository } from './infrastructure/repositories/cli-session-capture.repository';
import {
    CliSessionCaptureModel,
    CliSessionCaptureSchema,
} from './infrastructure/repositories/schemas/cli-session-capture.model';
import {
    FeaturedPublicReviewModel,
    FeaturedPublicReviewSchema,
} from './infrastructure/repositories/schemas/featured-public-review.model';
import { FeaturedPublicReviewRepository } from './infrastructure/repositories/featured-public-review.repository';
import { SessionEventModel } from './infrastructure/repositories/schemas/session-event.model';
import { SessionEventRepository } from './infrastructure/repositories/session-event.repository';
import { AuthenticatedRateLimiterService } from './infrastructure/services/authenticated-rate-limiter.service';
import { GitHubPublicPrService } from './infrastructure/services/github-public-pr.service';
import { PublicPrAiSummaryService } from './infrastructure/services/public-pr-ai-summary.service';
import { PublicPrGroupingService } from './infrastructure/services/public-pr-grouping.service';
import { TrialRateLimiterService } from './infrastructure/services/trial-rate-limiter.service';

// Contracts (DI tokens)
import { TRIAL_RATE_LIMITER_SERVICE_TOKEN } from './domain/contracts/trial-rate-limiter.service.contract';
import { AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN } from './domain/contracts/authenticated-rate-limiter.service.contract';
import { GITHUB_PUBLIC_PR_SERVICE_TOKEN } from './domain/contracts/github-public-pr.service.contract';
import { FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN } from './domain/contracts/featured-public-review.repository.contract';
import { PUBLIC_PR_AI_SUMMARY_SERVICE_TOKEN } from './domain/contracts/public-pr-ai-summary.service.contract';
import { PUBLIC_PR_GROUPING_SERVICE_TOKEN } from './domain/contracts/public-pr-grouping.service.contract';

// External dependencies
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodeReviewCoreModule } from '@libs/code-review/modules/code-review-core.module';
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
// Needed by ValidateCliKeyUseCase — exports AUTH_SERVICE_TOKEN +
// re-exports JwtModule (so JwtService resolves transitively).
import { AuthModule } from '@libs/identity/modules/auth.module';

// Workflow infra (provided locally to avoid an ESM circular import with
// WorkflowModule, which itself imports CliReviewModule on the worker side).
// Same pattern used by apps/webhooks/.../webhook-enqueue.module.ts.
import { WorkflowQueueLoader } from '@libs/core/infrastructure/config/loaders/workflow-queue.loader';
import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WORKFLOW_JOB_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { OutboxMessageRepository } from '@libs/core/workflow/infrastructure/repositories/outbox-message.repository';
import { OutboxMessageModel } from '@libs/core/workflow/infrastructure/repositories/schemas/outbox-message.model';

/**
 * Module for CLI code review functionality
 * Provides a simplified pipeline for analyzing code from CLI
 */
@Module({
    imports: [
        ConfigModule.forFeature(WorkflowQueueLoader),
        MongooseModule.forFeature([
            {
                name: CliSessionCaptureModel.name,
                schema: CliSessionCaptureSchema,
            },
            {
                name: FeaturedPublicReviewModel.name,
                schema: FeaturedPublicReviewSchema,
            },
        ]),
        TypeOrmModule.forFeature([
            SessionEventModel,
            WorkflowJobModel,
            OutboxMessageModel,
        ]),
        forwardRef(() => CodeReviewPipelineModule), // For reusing stages
        forwardRef(() => CodeReviewCoreModule), // For CODE_REVIEW_EXECUTION_SERVICE
        forwardRef(() => ParametersModule), // For config loading
        forwardRef(() => TeamModule), // For Team CLI Key validation
        forwardRef(() => AuthModule), // For ValidateCliKeyUseCase (AUTH_SERVICE_TOKEN + JwtService)
        forwardRef(() => GlobalCacheModule), // For rate limiting
        forwardRef(() => AutomationModule), // For tracking executions
        forwardRef(() => LicenseModule), // For license validation and auto-assign
        forwardRef(() => KodyRulesModule), // For loading kody rules in CLI review
        forwardRef(() => GithubModule), // For GitHubRateLimitGateService dependency
        forwardRef(() => PlatformCoreModule), // For CodeManagementService (platform resolution)
    ],
    providers: [
        // Strategy
        CliReviewPipelineStrategy,

        // Stages
        PrepareCliFilesStage,
        FormatCliOutputStage,

        // Use Cases
        EnqueueCliReviewUseCase,
        ExecuteCliReviewUseCase,
        PublicPrReviewUseCase,
        ListFeaturedPublicReviewsUseCase,
        GetFeaturedPublicReviewUseCase,
        ValidateCliKeyUseCase,
        GetCliReviewByIdUseCase,
        GetCliReviewsUseCase,
        GetCliReviewJobStatusUseCase,
        WaitForCliReviewJobUseCase,
        SubmitCliSessionCaptureUseCase,
        ClassifyCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        ClassifySessionUseCase,

        // Workflow
        CliReviewJobProcessorService,
        // GitHub rate-limit gate (shared instance)
        GitHubRateLimitGateService,
        {
            provide: RATE_LIMIT_GATE_SERVICE_TOKEN,
            useExisting: GitHubRateLimitGateService,
        },

        // Workflow infra (local to avoid circular import with WorkflowModule)
        WorkflowJobRepository,
        OutboxMessageRepository,
        {
            provide: WORKFLOW_JOB_REPOSITORY_TOKEN,
            useClass: WorkflowJobRepository,
        },
        {
            provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
            useClass: OutboxMessageRepository,
        },
        {
            provide: JOB_QUEUE_SERVICE_TOKEN,
            useClass: WorkflowJobQueueService,
        },

        // Services
        CliInputConverter,
        CliSessionCaptureRepository,
        SessionEventRepository,
        // Services + repos that must be consumed via DI tokens
        // (Kody rule: don't inject services/repos by concrete class).
        {
            provide: TRIAL_RATE_LIMITER_SERVICE_TOKEN,
            useClass: TrialRateLimiterService,
        },
        {
            provide: AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN,
            useClass: AuthenticatedRateLimiterService,
        },
        {
            provide: GITHUB_PUBLIC_PR_SERVICE_TOKEN,
            useClass: GitHubPublicPrService,
        },
        {
            provide: FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN,
            useClass: FeaturedPublicReviewRepository,
        },
        {
            provide: PUBLIC_PR_AI_SUMMARY_SERVICE_TOKEN,
            useClass: PublicPrAiSummaryService,
        },
        {
            provide: PUBLIC_PR_GROUPING_SERVICE_TOKEN,
            useClass: PublicPrGroupingService,
        },
    ],
    exports: [
        // Export use case and services for controllers
        EnqueueCliReviewUseCase,
        ExecuteCliReviewUseCase,
        PublicPrReviewUseCase,
        ListFeaturedPublicReviewsUseCase,
        GetFeaturedPublicReviewUseCase,
        ValidateCliKeyUseCase,
        GetCliReviewByIdUseCase,
        GetCliReviewsUseCase,
        GetCliReviewJobStatusUseCase,
        WaitForCliReviewJobUseCase,
        SubmitCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        ClassifySessionUseCase,
        CliReviewJobProcessorService,
        SessionEventRepository,
        ClassifySessionUseCase,
        JOB_QUEUE_SERVICE_TOKEN,
        TRIAL_RATE_LIMITER_SERVICE_TOKEN,
        AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN,
        GITHUB_PUBLIC_PR_SERVICE_TOKEN,
        FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN,
        PUBLIC_PR_AI_SUMMARY_SERVICE_TOKEN,
        PUBLIC_PR_GROUPING_SERVICE_TOKEN,
    ],
})
export class CliReviewModule {}
