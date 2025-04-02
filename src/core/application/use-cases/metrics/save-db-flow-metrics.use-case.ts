import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    METRICS_FACTORY_TOKEN,
    IMetricsFactory,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';

@Injectable()
export class SaveFlowMetricsToDbUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private logger: PinoLoggerService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
    ) {}

    async execute(teamId: string) {
        try {
            const team = await this.teamService.findOne({
                uuid: teamId,
            });

            return await this.metricsFactory.runDaily({
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error saving metrics',
                context: SaveFlowMetricsToDbUseCase.name,
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
        }
    }
}
