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
export class GetMetricsByOrganizationUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        private logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },
    ) {}

    async execute(
        organizationId?: string,
        startDate?: string,
        endDate?: string,
    ) {
        try {
            const _orgId =
                organizationId ?? this.request.user.organization.uuid;

            return await this.metricsService.getFlowMetricsByOrganizationIdAndPeriod(
                {
                    organizationId: _orgId,
                    startDate,
                    endDate,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving organization metrics by period',
                context: GetMetricsByOrganizationUseCase.name,
                serviceName: 'GetMetricsByOrganizationIdAndPeriod',
                error: error,
                metadata: {
                    organizationId: organizationId,
                    startDate: startDate,
                    endDate: endDate,
                },
            });
        }
    }
}
