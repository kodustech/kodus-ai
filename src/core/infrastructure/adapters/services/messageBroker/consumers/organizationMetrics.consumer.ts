import { Inject, Injectable, Logger, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import { IOrganizationMetricsService, ORGANIZATION_METRICS_SERVICE_TOKEN } from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class OrganizationMetricsConsumer {
    constructor(
        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private readonly organizationMetricsService: IOrganizationMetricsService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'metrics.runOrganizationMetrics',
        queue: 'metrics.organizationMetrics.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'metrics.runOrganizationMetrics',
            durable: true,
        },
    })
    async handleFlowDaily(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.organizationMetricsService.runDaily(
                payload.organizationId,
            );
        }
    }
}
