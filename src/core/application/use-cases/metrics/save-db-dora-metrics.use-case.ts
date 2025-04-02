import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';

@Injectable()
export class SaveDoraMetricsToDbUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private logger: PinoLoggerService,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IDoraMetricsFactory,
    ) {}

    async execute(teamId: string) {
        try {
            const team = await this.teamService.findOne({
                uuid: teamId,
            });

            return await this.doraMetricsFactory.runDaily({
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error saving DORA metrics',
                context: SaveDoraMetricsToDbUseCase.name,
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
        }
    }
}
