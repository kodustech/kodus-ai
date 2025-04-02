import { DORA_METRICS_FACTORY_TOKEN } from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { TeamMetricsConfig } from '@/shared/domain/interfaces/metrics';
import { mergeConfig } from '@/shared/utils/helpers';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SaveAllTeamMetricsHistoryUseCase {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IMetricsFactory,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private logger: PinoLoggerService,
    ) {}

    async execute(
        teamId: string,
        howManyHistoricalDays?: number,
        metricsConfig?: TeamMetricsConfig,
        metricsCategory: MetricsCategory = undefined,
    ): Promise<void> {
        try {
            if (!teamId) {
                throw new Error('Team ID is required');
            }

            const team = await this.teamService.findOne({ uuid: teamId });

            if (!team) {
                throw new Error('Team not found');
            }

            const organizationAndTeamData = {
                teamId: team.uuid,
                organizationId: team.organization.uuid,
            };

            const defaultMetricsConfig: TeamMetricsConfig = {
                considerAll: true,
                howManyHistoricalDays: howManyHistoricalDays || 90,
                analysisPeriod: {
                    startTime: null,
                    endTime: null,
                },
            };

            const metricsConfigMerged = mergeConfig(
                defaultMetricsConfig,
                metricsConfig,
            );

            const endDate =
                metricsConfigMerged.analysisPeriod.endTime ||
                new Date(new Date().setDate(new Date().getDate() - 1));

            const startDate = new Date(endDate);
            startDate.setDate(
                startDate.getDate() -
                    metricsConfigMerged.howManyHistoricalDays +
                    1,
            );

            metricsConfigMerged.analysisPeriod.startTime = startDate;
            metricsConfigMerged.analysisPeriod.endTime = endDate;

            if (
                metricsCategory === undefined ||
                metricsCategory === MetricsCategory.FLOW_METRICS
            ) {
                await this.metricsFactory.saveAllMetricsHistory(
                    organizationAndTeamData,
                    startDate,
                    endDate,
                    metricsConfigMerged,
                );
            }

            if (
                metricsCategory === undefined ||
                metricsCategory === MetricsCategory.DORA_METRICS
            ) {
                await this.doraMetricsFactory.saveAllMetricsHistory(
                    organizationAndTeamData,
                    startDate,
                    endDate,
                    metricsConfigMerged,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error saving metrics history',
                context: SaveAllTeamMetricsHistoryUseCase.name,
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
            throw error;
        }
    }
}
