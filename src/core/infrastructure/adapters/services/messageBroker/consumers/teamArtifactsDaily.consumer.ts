import { Inject, Injectable, UseFilters } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class TeamArtifactDailyConsumer {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'artifact.runTeamArtifactDaily',
        queue: 'artifact.teamArtifactDaily.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'artifact.runTeamArtifactDaily',
            durable: true,
        },
    })
    async handleFlowWeekly(message: any) {
        const payload = message?.payload;

        if (payload) {
            await this.teamArtifactsService.executeDaily({
                teamId: payload.teamId,
                organizationId: payload.organizationId,
            });
        }
    }
}
