import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    IOrganizationArtifactsService,
    ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class OrganizationArtifactWeeklyConsumer {
    constructor(
        @Inject(ORGANIZATION_ARTIFACTS_SERVICE_TOKEN)
        private readonly organizationArtifactsService: IOrganizationArtifactsService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'artifact.runOrganizationArtifactWeekly',
        queue: 'artifact.organizationArtifactWeekly.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'artifact.runOrganizationArtifactWeekly',
            durable: true,
        },
    })
    async handleFlowWeekly(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.organizationArtifactsService.executeWeekly({
                organizationId: payload.organizationId,
            });
        }
    }
}
