// rabbitMQWrapper.module.ts
import { Module, DynamicModule, Provider, Global } from '@nestjs/common';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQLoader } from '@/config/loaders/rabbitmq.loader';
import { MetricsModule } from './metrics.module';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import { MESSAGE_BROKER_SERVICE_TOKEN } from '@/shared/domain/contracts/message-broker.service.contracts';
import { MessageBrokerService } from '@/core/infrastructure/adapters/services/messageBroker/messageBroker.service';
import { OrganizationMetricsConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/organizationMetrics.consumer';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { OrganizationArtifactDailyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/organizationArtifactsDaily.consumer';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { OrganizationArtifactWeeklyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/organizationArtifactsWeekly.consumer';
import { TeamArtifactDailyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/teamArtifactsDaily.consumer';
import { TeamArtifactWeeklyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/teamArtifactsWeekly.consumer';
import { EnrichTeamArtifactWeeklyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/enrichTeamArtifactsWeekly.consumer';
import { WeeklyExecutiveCheckinConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/weeklyExecutiveCheckin.consumer';
import { AutomationStrategyModule } from './automationStrategy.module';
import { MetricsFlowDailyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/flowMetricsDaily.consumer';
import { MetricsDoraDailyConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/doraMetricsDaily.consumer';
import { CodeReviewFeedbackConsumer } from '@/core/infrastructure/adapters/services/messageBroker/consumers/codeReviewFeedback.consumer';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { TeamArtifactsModule } from './teamArtifacts.module';

@Global()
@Module({})
export class RabbitMQWrapperModule {
    static register(): DynamicModule {
        const imports = [
            ConfigModule.forRoot(),
            ConfigModule.forFeature(RabbitMQLoader),
            MetricsModule,
            OrganizationMetricsModule,
            OrganizationArtifactsModule,
            CodeReviewFeedbackModule,
            AutomationStrategyModule,
            TeamArtifactsModule,
        ];

        const providers: Provider[] = [
            {
                provide: MESSAGE_BROKER_SERVICE_TOKEN,
                useClass: MessageBrokerService,
            },
        ];

        const exports = [MESSAGE_BROKER_SERVICE_TOKEN];

        // Using a factory function to obtain the ConfigService
        const rabbitMQModule = RabbitMQModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: async (configService: ConfigService) => {
                const rabbitMQEnabled =
                    process.env.API_RABBITMQ_ENABLED === 'true';

                if (!rabbitMQEnabled) {
                    return null;
                }

                return {
                    exchanges: [
                        {
                            name: 'orchestrator.exchange.delayed',
                            type: 'x-delayed-message',
                            durable: true,
                            options: {
                                arguments: {
                                    'x-delayed-type': 'direct',
                                },
                            },
                        },
                        {
                            name: 'orchestrator.exchange.dlx',
                            type: 'topic',
                            durable: true,
                        },
                    ],
                    queues: [
                        {
                            name: 'dlx.queue',
                            exchange: 'orchestrator.exchange.dlx',
                            routingKey: '#',
                            createQueueIfNotExists: true,
                            queueOptions: {
                                durable: true,
                            },
                        },
                    ],
                    uri: configService.get<string>(
                        'rabbitMQConfig.API_RABBITMQ_URI',
                    ),
                    connectionInitOptions: {
                        wait: false,
                        timeout: 5000,
                        heartbeat: 60,
                    },
                    reconnectTimeInSeconds: 10,
                    enableControllerDiscovery: false,
                    prefetchCount: 1,
                };
            },
            inject: [ConfigService],
        });

        const rabbitMQEnabled = process.env.API_RABBITMQ_ENABLED === 'true';

        if (rabbitMQEnabled) {
            imports.push(rabbitMQModule);

            providers.push(
                MetricsFlowDailyConsumer,
                MetricsDoraDailyConsumer,
                OrganizationMetricsConsumer,
                OrganizationArtifactDailyConsumer,
                OrganizationArtifactWeeklyConsumer,
                TeamArtifactDailyConsumer,
                TeamArtifactWeeklyConsumer,
                EnrichTeamArtifactWeeklyConsumer,
                WeeklyExecutiveCheckinConsumer,
                CodeReviewFeedbackConsumer,
                RabbitmqConsumeErrorFilter,
            );
        }

        return {
            module: RabbitMQWrapperModule,
            imports: imports,
            providers: providers,
            exports: exports,
        };
    }
}
