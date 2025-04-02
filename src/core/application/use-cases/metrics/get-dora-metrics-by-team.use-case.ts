import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetDoraMetricsByTeamUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(teamId: string, startDate: string, endDate: string) {
        try {
            return await this.metricsService.getDoraMetricsByTeamIdAndPeriod(
                { teamId, organizationId: this.request.user.organization.uuid },
                startDate,
                endDate,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving DORA metrics for the team by period',
                context: GetDoraMetricsByTeamUseCase.name,
                serviceName: 'GetMetricsByTeamIdAndPeriod',
                error: error,
                metadata: {
                    teamId: teamId,
                    startDate: startDate,
                    endDate: endDate,
                },
            });
            throw error;
        }
    }
}
