import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { REQUEST } from '@nestjs/core';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CacheService } from '@/shared/utils/cache/cache.service';

@Injectable()
export class GetTeamMetricsByIdUseCase {
    constructor(
        @Inject(METRICS_SERVICE_TOKEN)
        private metricsService: IMetricsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },

        private logger: PinoLoggerService,
        private readonly cacheService: CacheService,
    ) {}

    async execute(teamId: string) {
        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                teamId: teamId,
                organizationId: this.request.user.organization.uuid,
            };

            const cacheKey = `metrics_team_${organizationAndTeamData.organizationId}_${organizationAndTeamData.teamId}`;

            const cachedMetrics =
                await this.cacheService.getFromCache(cacheKey);

            if (cachedMetrics) {
                return cachedMetrics;
            }

            const metrics =
                await this.metricsService.compareCurrentAndLastWeekFlowMetrics(
                    organizationAndTeamData,
                );

            await this.cacheService.addToCache(cacheKey, metrics, 600000);

            return metrics;
        } catch (error) {
            this.logger.error({
                message:
                    'Error calculating metrics for the organization via API',
                context: GetTeamMetricsByIdUseCase.name,
                serviceName: 'GetTeamMetricsByIdUseCase',
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
            return [];
        }
    }
}
