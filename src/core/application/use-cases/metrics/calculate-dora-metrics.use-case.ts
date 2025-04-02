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
export class CalculateDoraMetricsUseCase {
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

            if (!team) {
                this.logger.warn({
                    message: 'Team not found.',
                    context: CalculateDoraMetricsUseCase.name,
                    metadata: {
                        teamId,
                    },
                });
                return 'Team Not Found';
            }

            return await this.doraMetricsFactory.getRealTime({
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing weekly progress automation',
                context: CalculateDoraMetricsUseCase.name,
                serviceName: 'CalculateMetricsUseCase',
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
        }
    }
}
