import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    IOrganizationArtifactsService,
    ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class OrganizationArtifactDailyConsumer {
    constructor(
        @Inject(ORGANIZATION_ARTIFACTS_SERVICE_TOKEN)
        private readonly organizationArtifactsService: IOrganizationArtifactsService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'artifact.runOrganizationArtifactDaily',
        queue: 'artifact.organizationArtifactDaily.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'artifact.runOrganizationArtifactDaily',
            durable: true,
        },
    })
    async handleFlowWeekly(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.organizationArtifactsService.executeDaily({
                organizationId: payload.organizationId,
            });
        }
    }
}
