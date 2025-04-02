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
export class GetTeamDoraMetricsForCockPitUseCase {
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

            const cacheKey = `dora_metrics_team_${organizationAndTeamData.organizationId}_${organizationAndTeamData.teamId}`;
            const cachedMetrics =
                await this.cacheService.getFromCache(cacheKey);

            if (cachedMetrics) {
                return cachedMetrics;
            }

            const doraMetrics =
                await this.metricsService.compareCurrentAndLastWeekDoraMetrics(
                    organizationAndTeamData,
                );

            await this.cacheService.addToCache(cacheKey, doraMetrics, 600000);

            return doraMetrics;
        } catch (error) {
            this.logger.error({
                message: 'Error calculating DORA metrics for the team',
                context: GetTeamDoraMetricsForCockPitUseCase.name,
                serviceName: 'GetTeamDoraMetricsByIdUseCase',
                error: error,
                metadata: {
                    teamId: teamId,
                    organization: this.request.user.organization.uuid,
                },
            });
            throw error;
        }
    }
}
