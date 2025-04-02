import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { PinoLoggerService } from '../../logger/pino.service';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class MetricsDoraDailyConsumer {
    constructor(
        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IDoraMetricsFactory,
        private logger: PinoLoggerService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'metrics.runDoraDaily',
        queue: 'metrics.doraDaily.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'metrics.runDoraDaily',
            durable: true,
        },
    })
    async handleRunDoraDaily(message: any) {
        const payload = message?.payload;

        if (payload) {
            try {
                // Processing the daily metric for the team
                await this.doraMetricsFactory.runDaily({
                    teamId: payload.teamId,
                    organizationId: payload.organizationId,
                });

                // Log to confirm successful processing
                this.logger.debug({
                    message: `Processing for team ${payload.teamId} completed successfully.`,
                    context: MetricsDoraDailyConsumer.name,
                    metadata: {
                        teamId: payload.teamId,
                        organizationId: payload.organizationId,
                        timestamp: new Date().toISOString(),
                    },
                });
            } catch (error) {
                // If an error occurs, it will be logged for investigation
                this.logger.error({
                    message: `Error processing DORA metrics for team ${payload.teamId}`,
                    context: MetricsDoraDailyConsumer.name,
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
                message: 'Message without payload received by the consumer',
                context: MetricsDoraDailyConsumer.name,
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
