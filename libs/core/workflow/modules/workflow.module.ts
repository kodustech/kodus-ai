import * as dotenv from 'dotenv';
// Cascade: .env.local (per-dev) wins, .env (team baseline) fills the rest.
// dotenv won't override an already-set key, so loading .env.local first
// is what makes the override semantics work.
dotenv.config({ path: '.env.local' });
dotenv.config();

import {
    Module,
    forwardRef,
    DynamicModule,
    ModuleMetadata,
    Provider,
} from '@nestjs/common';
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { CliReviewModule } from '@libs/cli-review/cli-review.module';
import { WorkflowCoreModule } from './workflow-core.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';

// Engine
import { HeavyStageEventHandler } from '@libs/core/workflow/engine/heavy-stage-event.handler';

// Infrastructure - Services
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';
import { WorkflowJobConsumer } from '@libs/core/workflow/infrastructure/workflow-job-consumer.service';
import { CrossProcessEventsBridge } from '@libs/core/workflow/infrastructure/cross-process-events.bridge';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { ErrorClassifierService } from '@libs/core/workflow/infrastructure/error-classifier.service';
import { JobProcessorRouterService } from '@libs/core/workflow/infrastructure/job-processor-router.service';
import { WebhookProcessingJobProcessorService } from '@libs/automation/webhook-processing/webhook-processing-job.processor';

// Domain contracts
import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { JOB_PROCESSOR_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ERROR_CLASSIFIER_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/error-classifier.service.contract';

// Use Cases
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { ProcessWorkflowJobUseCase } from '@libs/core/workflow/application/use-cases/process-workflow-job.use-case';
import { GetJobStatusUseCase } from '@libs/core/workflow/application/use-cases/get-job-status.use-case';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { EnqueueAstGraphUpdateOnMergedUseCase } from '@libs/code-review/application/use-cases/enqueue-ast-graph-update-on-merged.use-case';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { ASTEventHandler } from '@libs/core/workflow/infrastructure/ast-event-handler.service';
import { AstGraphBuildJobProcessor } from '@libs/code-review/workflow/ast-graph-build-job.processor';
import { AstGraphIncrementalJobProcessor } from '@libs/code-review/workflow/ast-graph-incremental-job.processor';
import { EcsModule } from '@libs/ee/infrastructure/ecs/ecs.module';
import { environment } from '@libs/ee/configs/environment';
import { TASK_PROTECTION_SERVICE_TOKEN } from '../domain/contracts/task-protection.service.contract';
import { NoOpTaskProtectionService } from '../infrastructure/noop-task-protection.service';

const sharedProviders = [
    // Cross-process event delivery (pull-request.closed, pr-execution.updated)
    // over PG LISTEN/NOTIFY — must run in BOTH the API and the worker.
    CrossProcessEventsBridge,
    {
        provide: JOB_QUEUE_SERVICE_TOKEN,
        useClass: WorkflowJobQueueService,
    },

    // Default NoOp implementation (overridden by EcsModule if imported)
    // Note: If EcsModule is imported in `register`, it needs to export the token.
    // However, NestJS providers are scoped to module unless exported.
    // We will provide a fallback here if not provided elsewhere?
    // Actually, simplest is to provide NoOp here, and let the register method decide.
    // But since `isWorker` check is inside register, we can do it there.

    EnqueueCodeReviewJobUseCase,
    GetJobStatusUseCase,
    EnqueueImplementationCheckUseCase,
    EnqueueAstGraphUpdateOnMergedUseCase,
];

const sharedExports = [
    JOB_QUEUE_SERVICE_TOKEN,
    EnqueueCodeReviewJobUseCase,
    GetJobStatusUseCase,
    EnqueueImplementationCheckUseCase,
    EnqueueAstGraphUpdateOnMergedUseCase,
];

const workerProviders = [
    // Engine - Worker specific
    HeavyStageEventHandler,

    // Services
    {
        provide: JOB_PROCESSOR_SERVICE_TOKEN,
        useClass: JobProcessorRouterService,
    },
    {
        provide: ERROR_CLASSIFIER_SERVICE_TOKEN,
        useClass: ErrorClassifierService,
    },
    DistributedLockService,
    JobProcessorRouterService,
    ASTEventHandler,

    // Processors
    WebhookProcessingJobProcessorService,
    AstGraphBuildJobProcessor,
    AstGraphIncrementalJobProcessor,

    // Consumers
    WorkflowJobConsumer,

    // Use Cases
    ProcessWorkflowJobUseCase,
];

import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';

@Module({})
export class WorkflowModule {
    static register(options: {
        type: 'worker' | 'api' | 'webhook';
    }): DynamicModule {
        const isWorker = options.type === 'worker';
        const useEcs = environment.API_CLOUD_MODE;

        const imports: ModuleMetadata['imports'] = [
            WorkflowCoreModule,
            forwardRef(() => CodeReviewPipelineModule),
            forwardRef(() => CodebaseModule),
            forwardRef(() => PlatformModule),
            forwardRef(() => AutomationModule),
            forwardRef(() => IntegrationConfigCoreModule),
            forwardRef(() => PermissionValidationModule),
            SharedMongoModule, // Ensure MongoDB is available for worker
            ...(isWorker && useEcs ? [EcsModule] : []),
            ...(isWorker ? [forwardRef(() => CliReviewModule)] : []),
        ];

        const providers: Provider[] = [
            ...sharedProviders,
            ...(isWorker ? workerProviders : []),
        ];

        // If not using ECS Module (which provides the token), provide NoOp
        if (!useEcs || !isWorker) {
            providers.push({
                provide: TASK_PROTECTION_SERVICE_TOKEN,
                useClass: NoOpTaskProtectionService,
            });
        }

        return {
            module: WorkflowModule,
            imports: imports,
            providers: providers,
            exports: [
                WorkflowCoreModule,
                ...sharedExports,
                ...(isWorker ? workerProviders : []),
            ],
        };
    }
}
