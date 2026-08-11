import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { EmailModule } from '@libs/common/email/email.module';
import { SharedCoreModule } from '@libs/shared/infrastructure/shared-core.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';
import { FeatureGateModule } from '@libs/feature-gate/modules/feature-gate.module';
import { LangfuseShutdownProvider } from '@libs/core/log/langfuse-shutdown.provider';
import { WebhookEnqueueModule } from './webhook-enqueue.module';

import { NotificationModule } from '@libs/notifications/modules/notification.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { LLMModule } from '@kodus/kodus-common/llm';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';

import { AzureReposController } from '../controllers/azureRepos.controller';
import { BillingController } from '../controllers/billing.controller';
import { BitbucketController } from '../controllers/bitbucket.controller';
import { ForgejoController } from '../controllers/forgejo.controller';
import { GithubController } from '../controllers/github.controller';
import { GitlabController } from '../controllers/gitlab.controller';
import { WebhookHealthController } from '../controllers/webhook-health.controller';

@Module({
    imports: [
        SharedCoreModule,
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        TelemetryModule,
        FeatureGateModule,
        SharedPostgresModule.forRoot({ poolSize: 8 }),
        SharedMongoModule.forRoot(),
        LLMModule.forRoot({
            logger: LoggerWrapperService,
        }),

        EventEmitterModule.forRoot(),
        RabbitMQWrapperModule.register({ enableConsumers: false }),
        WebhookEnqueueModule,
        EmailModule,
        NotificationModule,
        KodyRulesModule,
    ],
    controllers: [
        GithubController,
        GitlabController,
        BitbucketController,
        AzureReposController,
        ForgejoController,
        WebhookHealthController,
        BillingController,
    ],
    providers: [LangfuseShutdownProvider],
})
export class WebhookHandlerModule {}
