import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { LLMModule } from '@kodus/kodus-common/llm';

import { AnalyticsWarehouseModule } from '@libs/ee/analytics-warehouse';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CockpitModule } from '@libs/cockpit/modules/cockpit.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { CodeReviewFeedbackModule } from '@libs/code-review/modules/codeReviewFeedback.module';
import { IncidentModule } from '@libs/core/infrastructure/incident/incident.module';
import { ErrorRateMonitorService } from '@libs/core/infrastructure/metrics/error-rate-monitor.service';
import { MetricsModule } from '@libs/core/infrastructure/metrics/metrics.module';
import { ReviewResponseMonitorService } from '@libs/core/infrastructure/metrics/review-response-monitor.service';
import { WebhookFailureMonitorService } from '@libs/core/infrastructure/metrics/webhook-failure-monitor.service';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { LangfuseShutdownProvider } from '@libs/core/log/langfuse-shutdown.provider';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { OutboxRelayService } from '@libs/core/workflow/infrastructure/outbox-relay.service';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { SelfHostedBeaconModule } from '@libs/telemetry/modules/self-hosted-beacon.module';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';
import { FeatureGateModule } from '@libs/feature-gate/modules/feature-gate.module';
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

import { AnalyticsClassifierCron } from './cron/analytics-classifier.cron';
import { AnalyticsIngestionCron } from './cron/analytics-ingestion.cron';
import { SelfHostedBeaconCron } from './cron/self-hosted-beacon.cron';
import { OrgReportCron } from './cron/org-report.cron';
import { RepoReportCron } from './cron/repo-report.cron';
import { resolveWorkerRole, type WorkerRole } from './worker-role';
import { WorkerDrainService } from './worker-drain.service';
import { WorkerHealthGuardService } from './worker-health-guard.service';

/**
 * Worker boots code-review OR analytics — never both. See
 * `./worker-role.ts` for the contract. Self-hosted telemetry is wired to the
 * code-review role because that is the mandatory worker in every deployment;
 * analytics is optional for community installs.
 */
@Module({})
export class WorkerModule {
    static forRoot(): DynamicModule {
        const role: WorkerRole = resolveWorkerRole();

        const baseImports = [
            ScheduleModule.forRoot(),
            SharedConfigModule,
            SharedLogModule,
            SharedObservabilityModule,
            TelemetryModule,
            FeatureGateModule,
            IncidentModule,
            MetricsModule,
            // Both roles read Mongo: code-review writes PR state; analytics
            // reads `pullRequests` for ingestion.
            SharedMongoModule.forRoot(),
        ];

        if (role === 'code-review') {
            return {
                module: WorkerModule,
                imports: [
                    ...baseImports,
                    SharedPostgresModule.forRoot({ poolSize: 12 }),
                    RabbitMQWrapperModule.register({ enableConsumers: true }),
                    LLMModule.forRoot({ logger: LoggerWrapperService }),
                    WorkflowModule.register({ type: 'worker' }),
                    CodebaseModule,
                    CodeReviewFeedbackModule,
                    AutomationModule,
                    PlatformModule,
                    SandboxModule, // provides SANDBOX_LEASE_MANAGER_TOKEN for OutboxRelayService
                    NotificationModule,
                    SelfHostedBeaconModule,
                ],
                providers: [
                    WorkerDrainService,
                    WorkerHealthGuardService,
                    OutboxRelayService,
                    ErrorRateMonitorService,
                    ReviewResponseMonitorService,
                    WebhookFailureMonitorService,
                    SelfHostedBeaconCron,
                    LangfuseShutdownProvider,
                ] satisfies Provider[],
            };
        }

        // analytics
        return {
            module: WorkerModule,
            imports: [
                ...baseImports,
                // LLM is needed by the PR-type classifier; the ingestion
                // hot path itself doesn't call any model.
                LLMModule.forRoot({ logger: LoggerWrapperService }),
                AnalyticsWarehouseModule.forRoot(),
                // Postgres for cockpit warehouse queries used by the
                // repo/org report crons.
                SharedPostgresModule.forRoot({ poolSize: 4 }),
                // Wired with `enableConsumers: false` because the
                // analytics role does NOT consume queue messages — but
                // OrganizationModule transitively pulls in PlatformModule
                // → WorkflowModule, which provides WorkflowJobQueueService.
                // That service constructor-injects MESSAGE_BROKER_SERVICE_TOKEN
                // and Nest fails to build the DI graph if the token isn't
                // provided, even though analytics never calls enqueue().
                // Wiring the wrapper here costs one idle AMQP connection
                // and unblocks the boot. Refactoring the OrganizationParametersModule
                // → PlatformModule edge is the cleaner long-term fix but
                // is out of scope here.
                RabbitMQWrapperModule.register({ enableConsumers: false }),
                // Cockpit pulls in EmailModule + UserModule for the report
                // email rendering. OrganizationModule is imported separately
                // because the report crons inject ORGANIZATION_SERVICE_TOKEN
                // to fan out across orgs, and CockpitModule doesn't re-export
                // that token.
                CockpitModule,
                OrganizationModule,
            ],
            providers: [
                WorkerDrainService,
                WorkerHealthGuardService,
                AnalyticsIngestionCron,
                AnalyticsClassifierCron,
                OrgReportCron,
                RepoReportCron,
                LangfuseShutdownProvider,
            ] satisfies Provider[],
        };
    }
}
