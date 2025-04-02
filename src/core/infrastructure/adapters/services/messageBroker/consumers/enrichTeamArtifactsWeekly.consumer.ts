import { Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import { EnrichTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts/enrich-team-artifacts.use-case';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class EnrichTeamArtifactWeeklyConsumer {
    constructor(
        private readonly enrichTeamArtifactUseCase: EnrichTeamArtifactsUseCase,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'artifact.runEnrichTeamArtifactWeekly',
        queue: 'artifact.enrichTeamArtifactWeekly.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'artifact.runEnrichTeamArtifactWeekly',
            durable: true,
        },
    })
    async handleFlowWeekly(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.enrichTeamArtifactUseCase.execute(
                {
                    teamId: payload.teamId,
                    organizationId: payload.organizationId,
                },
                payload.isProjectManagementConfigured,
                payload.isCodeManagementConfigured,
            );
        }
    }
}
