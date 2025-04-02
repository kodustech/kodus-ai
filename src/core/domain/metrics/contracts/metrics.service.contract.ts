import { MetricsEntity } from '@/core/domain/metrics/entities/metrics.entity';
import { IMetricsRepository } from './metrics.repository.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    DoraMetricsResults,
    FlowMetricsResults,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';
import { IMetrics } from '../interfaces/metrics.interface';
import { MetricTrend } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metricAnalyzerAndFormatter';

export const METRICS_SERVICE_TOKEN = Symbol('MetricsService');

export interface IMetricsService extends IMetricsRepository {
    //#region Team Metrics
    findLastSavedMetricsToMetricsResults(
        teamId: string,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Promise<{
        flowMetrics: FlowMetricsResults;
        doraMetrics: DoraMetricsResults;
    }>;

    getSecondToLastSavedMetricsByTeamIdAndMetricType(
        teamId: string,
        type: METRICS_TYPE,
    ): Promise<MetricsEntity>;
    //#endregion

    //#region Flow Metrics
    getFlowMetricsByTeamIdAndPeriod(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: string,
        endDate: string,
        newItemsFrom: string,
    ): Promise<any>;

    getFlowMetricsByOrganizationIdAndPeriod(params: {
        organizationId: string;
        startDate?: string;
        endDate?: string;
    }): Promise<any>;

    getLeadTimeInWipItemTypeByTeamIdAndPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        startDate?: string;
        endDate?: string;
    }): Promise<any>;

    getLeadTimeInWipItemTypeByOrganizationIdAndPeriod(params: {
        organizationId: string;
        startDate?: string;
        endDate?: string;
    }): Promise<any>;

    compareCurrentAndLastWeekFlowMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    //#endregion

    //#region Dora Metrics
    getDoraMetricsByTeamIdAndPeriod(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: string,
        endDate: string,
    ): Promise<any>;

    getDoraMetricsByOrganizationIdAndPeriod(params: {
        organizationId: string;
        startDate?: string;
        endDate?: string;
    }): Promise<any>;

    compareCurrentAndLastWeekDoraMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    //#endregion

    getTeamMetricsByPeriod(
        teamId: string,
        howManyDays?: number,
        currentDate?: Date,
    ): Promise<IMetrics[]>;

    MapToMetricsTrend(metrics: MetricsEntity[]): Record<string, MetricTrend[]>;

    MapToIMetrics(metrics: MetricsEntity[], teamId: string): IMetrics[];
}
