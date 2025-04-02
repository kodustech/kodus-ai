import { IMetrics } from '../interfaces/metrics.interface';

import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { MetricTrend } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metricAnalyzerAndFormatter';
import {
    MetricsConversionStructure,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';

export const DORA_METRICS_FACTORY_TOKEN = Symbol('DoraMetricsFactory');

export type DoraMetricsConfig = {
    analysisPeriod?: {
        startTime: Date;
        endTime: Date;
    };
    checkConnectionByOneTeam?: boolean;
    weekDay?: number;
    daysInterval?: number;
};

export interface IDoraMetricsFactory {
    runDaily(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConfig?: Partial<DoraMetricsConfig>,
    );
    getRealTime(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConfig?: Partial<DoraMetricsConfig>,
    ): Promise<IMetrics[] | {}>;
    getDoraMetricsHistoryWithConfigurableParams(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConversionStructure?: MetricsConversionStructure,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Promise<any>;
    saveAllMetricsHistory(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: Date,
        endDate: Date,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
    ): Promise<void>;
}
