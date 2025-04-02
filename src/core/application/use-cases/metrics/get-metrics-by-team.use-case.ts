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
import { NewItemsFrom } from '@/core/infrastructure/adapters/services/metrics/processMetrics/deliveryCapacity';

@Injectable()
export class GetMetricsByTeamUseCase {
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

    async execute(
        teamId: string,
        startDate: string,
        endDate: string,
        newItemsFrom: NewItemsFrom,
    ) {
        try {
            return await this.metricsService.getFlowMetricsByTeamIdAndPeriod(
                { teamId, organizationId: this.request.user.organization.uuid },
                startDate,
                endDate,
                newItemsFrom,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving team metrics for the period',
                context: GetMetricsByTeamUseCase.name,
                serviceName: 'GetMetricsByTeamIdAndPeriod',
                error: error,
                metadata: {
                    teamId: teamId,
                    startDate: startDate,
                    endDate: endDate,
                },
            });
        }
    }
}
