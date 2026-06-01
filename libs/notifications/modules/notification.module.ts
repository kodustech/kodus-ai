import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Domain models
import { NotificationDeliveryModel } from '../infrastructure/repositories/schemas/notification-delivery.model';
import { UserNotificationModel } from '../infrastructure/repositories/schemas/user-notification.model';
import { RoutingRuleModel } from '../infrastructure/repositories/schemas/routing-rule.model';

// Repository implementations
import { NotificationDeliveryRepository } from '../infrastructure/repositories/notification-delivery.repository';
import { UserNotificationRepository } from '../infrastructure/repositories/user-notification.repository';
import { RoutingRuleRepository } from '../infrastructure/repositories/routing-rule.repository';

// Repository tokens
import { NOTIFICATION_DELIVERY_REPOSITORY_TOKEN } from '../domain/contracts/notification-delivery.repository.contract';
import { USER_NOTIFICATION_REPOSITORY_TOKEN } from '../domain/contracts/user-notification.repository.contract';
import { ROUTING_RULE_REPOSITORY_TOKEN } from '../domain/contracts/routing-rule.repository.contract';

// Application services
import { ByokErrorCounter } from '../application/byok-error-counter.service';
import { NotificationService } from '../application/notification.service';
import { NotificationDispatcherService } from '../application/notification-dispatcher.service';
import { NotificationQueryService } from '../application/notification-query.service';
import { NotificationRateLimiter } from '../application/notification-rate-limiter.service';
import { NotificationRetryService } from '../application/notification-retry.service';
import { NotificationSseService } from '../application/notification-sse.service';
import { PrAuthorRecipientResolver } from '../application/pr-author-recipient.resolver';
import { RoutingRuleService } from '../application/routing-rule.service';

// Channel adapters
import { EmailChannelAdapter } from '../infrastructure/adapters/channels/email-channel.adapter';
import { InAppChannelAdapter } from '../infrastructure/adapters/channels/in-app-channel.adapter';
import { CHANNEL_ADAPTERS_TOKEN } from '../domain/contracts/channel-adapter.contract';

// Email providers
import { EMAIL_PROVIDER_TOKEN } from '../infrastructure/adapters/email-providers/email-provider.contract';
import { ResendEmailProvider } from '../infrastructure/adapters/email-providers/resend-email.provider';
import { SmtpEmailProvider } from '../infrastructure/adapters/email-providers/smtp-email.provider';

// Consumer
import { NotificationConsumer } from '../infrastructure/consumers/notification.consumer';

// Identity — needed by dispatcher for user resolution
import { UserCoreModule } from '@libs/identity/modules/user-core.module';

// Cache (Redis/in-memory) — used by ByokErrorCounter and NotificationRateLimiter.
import { GlobalCacheModule } from '@libs/core/cache/cache.module';

// Workflow core — provides OUTBOX_MESSAGE_REPOSITORY_TOKEN and
// MESSAGE_BROKER_SERVICE_TOKEN (the latter is also exported from the
// @Global RabbitMQWrapperModule). NotificationService writes to the
// outbox; the relay then publishes via the broker.
import { WorkflowCoreModule } from '@libs/core/workflow/modules/workflow-core.module';

/**
 * Full notification module — wires everything: repos, services, adapters,
 * and the RabbitMQ consumer. Import in API (for query endpoints) and
 * worker (for the consumer).
 */
@Module({
    imports: [
        ConfigModule,
        UserCoreModule,
        // GlobalCacheModule is @Global, but the webhooks app doesn't
        // pull it in via any other path. Importing it here keeps
        // NotificationModule self-sufficient — ByokErrorCounter and
        // NotificationRateLimiter both need CacheService.
        GlobalCacheModule,
        // Same self-sufficiency story for the outbox repository: api
        // and worker get WorkflowCoreModule via WorkflowModule, but the
        // webhooks app uses the lighter WebhookEnqueueModule which
        // doesn't expose the token across module boundaries. @Global so
        // double-registration is idempotent.
        WorkflowCoreModule,
        // ScheduleModule.forRoot() is idempotent across the dependency
        // graph — Nest only registers the scheduler once. Importing it
        // here means the notifications module's @Cron-driven worker
        // runs even in deployments that don't pull in CronModule.
        ScheduleModule.forRoot(),
        TypeOrmModule.forFeature([
            NotificationDeliveryModel,
            UserNotificationModel,
            RoutingRuleModel,
        ]),
    ],
    providers: [
        // ── Repositories ──────────────────────────────────────
        {
            provide: NOTIFICATION_DELIVERY_REPOSITORY_TOKEN,
            useClass: NotificationDeliveryRepository,
        },
        {
            provide: USER_NOTIFICATION_REPOSITORY_TOKEN,
            useClass: UserNotificationRepository,
        },
        {
            provide: ROUTING_RULE_REPOSITORY_TOKEN,
            useClass: RoutingRuleRepository,
        },

        // ── Email provider (conditional) ──────────────────────
        {
            provide: EMAIL_PROVIDER_TOKEN,
            useFactory: (configService: ConfigService) => {
                const provider = configService.get<string>(
                    'API_NOTIFICATION_EMAIL_PROVIDER',
                    'resend',
                );
                if (provider === 'smtp') {
                    return new SmtpEmailProvider(configService);
                }
                return new ResendEmailProvider(configService);
            },
            inject: [ConfigService],
        },

        // ── Channel adapters ──────────────────────────────────
        EmailChannelAdapter,
        InAppChannelAdapter,
        {
            provide: CHANNEL_ADAPTERS_TOKEN,
            useFactory: (
                email: EmailChannelAdapter,
                inApp: InAppChannelAdapter,
            ) => [email, inApp],
            inject: [EmailChannelAdapter, InAppChannelAdapter],
        },

        // ── Application services ──────────────────────────────
        ByokErrorCounter,
        NotificationService,
        NotificationDispatcherService,
        NotificationQueryService,
        NotificationRateLimiter,
        NotificationRetryService,
        NotificationSseService,
        PrAuthorRecipientResolver,
        RoutingRuleService,

        // ── Consumer ──────────────────────────────────────────
        NotificationConsumer,
    ],
    exports: [
        ByokErrorCounter,
        NotificationService,
        NotificationQueryService,
        NotificationRateLimiter,
        NotificationSseService,
        PrAuthorRecipientResolver,
        RoutingRuleService,
    ],
})
export class NotificationModule {}
