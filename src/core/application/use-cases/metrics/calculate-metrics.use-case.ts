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
export class CalculateMetricsUseCase {
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

            if (!team) {
                this.logger.warn({
                    message: 'Team not found.',
                    context: CalculateMetricsUseCase.name,
                    metadata: {
                        teamId,
                    },
                });
                return 'Team Not Found';
            }

            return await this.metricsFactory.getRealTime({
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing weekly progress automation',
                context: CalculateMetricsUseCase.name,
                serviceName: 'CalculateMetricsUseCase',
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
        }
    }
}
