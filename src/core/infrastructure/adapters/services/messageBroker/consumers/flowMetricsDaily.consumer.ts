import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { PinoLoggerService } from '../../logger/pino.service';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class MetricsFlowDailyConsumer {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
        private logger: PinoLoggerService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'metrics.runFlowDaily',
        queue: 'metrics.flowDaily.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'metrics.runFlowDaily',
            durable: true,
        },
    })
    async handleFlowDaily(message: any) {
        const payload = message?.payload;

        if (payload) {
            try {
                // Processing the daily metric for the team
                await this.metricsFactory.runDaily({
                    teamId: payload.teamId,
                    organizationId: payload.organizationId,
                });

                // Log to confirm successful processing
                this.logger.debug({
                    message: `Processing for team ${payload.teamId} completed successfully.`,
                    context: MetricsFlowDailyConsumer.name,
                    metadata: {
                        teamId: payload.teamId,
                        organizationId: payload.organizationId,
                        timestamp: new Date().toISOString(),
                    },
                });
            } catch (error) {
                // If an error occurs, it will be logged for investigation
                this.logger.error({
                    message: `Error processing flow metrics for team ${payload.teamId}`,
                    context: MetricsFlowDailyConsumer.name,
                    error: error.message,
                    metadata: {
                        teamId: payload.teamId,
                        organizationId: payload.organizationId,
                        timestamp: new Date().toISOString(),
                    },
                });

                // Let the error propagate so the filter handles retry logic
                throw error;
            }
        } else {
            // If the message has no payload, log an error
            this.logger.error({
                message: 'Message with no payload received by the consumer',
                context: MetricsFlowDailyConsumer.name,
                metadata: {
                    message,
                    timestamp: new Date().toISOString(),
                },
            });

            // You can choose to discard or manually nack here
            throw new Error('Invalid message: no payload');
        }
    }
}
