import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class TeamArtifactWeeklyConsumer {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'artifact.runTeamArtifactWeekly',
        queue: 'artifact.teamArtifactWeekly.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'artifact.runTeamArtifactWeekly',
            durable: true,
        },
    })
    async handleFlowWeekly(message: any, artifactsToolType: ArtifactsToolType) {
        const payload = message?.payload;

        if (payload) {
            await this.teamArtifactsService.executeWeekly(
                {
                    teamId: payload.teamId,
                    organizationId: payload.organizationId,
                },
                artifactsToolType,
            );
        }
    }
}
