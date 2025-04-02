import { ColumnsConfigResult } from '../../integrationConfigs/types/projectManagement/columns.type';
import { METRICS_TYPE } from '../enums/metrics.enum';
import { IMetrics } from '../interfaces/metrics.interface';
import { MetricTrend } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metricAnalyzerAndFormatter';
import {
    Item,
    ItemWithDeliveryStatus,
    WorkItemAging,
    WorkItemType,
} from '../../platformIntegrations/types/projectManagement/workItem.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ISprint } from '../../platformIntegrations/interfaces/jiraSprint.interface';
import {
    FlowMetricsResults,
    MetricsConversionStructure,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';

export const METRICS_FACTORY_TOKEN = Symbol('MetricsFactory');

export type FlowMetricsConfig = {
    considerAll: boolean;
    projectManagementFilter?: {
        createDate?: string;
        updatedDate?: string;
    };
    analysisPeriod?: {
        startTime: Date;
        endTime: Date;
    };
    daysInterval?: number;
    weekDay?: number;
};

export interface IMetricsFactory {
    runDaily(organizationAndTeamData: OrganizationAndTeamData);
    getWorkItemsDeliveryStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
        metrics: any,
        columnsConfig: ColumnsConfigResult,
        teamMethodology: string,
        sprint?: ISprint,
    ): Promise<ItemWithDeliveryStatus[]>;
    getRealTime(
        organizationAndTeamData: OrganizationAndTeamData,
        FlowMetricsConfig?: Partial<FlowMetricsConfig>,
    ): Promise<IMetrics[]>;
    getRealTimeAndHistoricalMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
        FlowMetricsConfig?: Partial<FlowMetricsConfig>,
    ): Promise<MetricTrend[]>;
    calculateForWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: any[],
        columnsConfig: ColumnsConfigResult,
    );
    getSecondToLastSavedMetricsByTeamIdAndMetricType(
        organizationAndTeamData: OrganizationAndTeamData,
        type: METRICS_TYPE,
    ): Promise<IMetrics>;
    calculateAll(
        columns: any[],
        columnsConfig: ColumnsConfigResult,
        workItemType: WorkItemType[],
        typeBugNames: string[],
        todayDate?: Date,
        FlowMetricsConfig?: Partial<FlowMetricsConfig>,
    ): FlowMetricsResults;

    calcDiff(
        metrics: IMetrics[],
        secondToLastMetric: IMetrics,
        metricToCalc: METRICS_TYPE,
    );

    estimateWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        leadTimeInWipPercentiles: {
            p50: number;
            p75: number;
            p95: number;
        },
        workItems?: Item[],
    ): Promise<any>;

    getAgingForWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
    ): Promise<WorkItemAging[]>;

    saveAllMetricsHistory(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: Date,
        endDate: Date,
        FlowMetricsConfig: Partial<FlowMetricsConfig>,
        generateHistory?: boolean,
    );

    getFlowMetricsHistoryWithConfigurableParams(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConversionStructure?: MetricsConversionStructure,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Promise<any>;
}
