import { BugRatioCalculator } from './bugRatio';
import { ThroughputCalculator } from './throughput';
import { LeadTimeCalculator } from './leadTime';
import { Inject } from '@nestjs/common';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import {
    FlowMetricsConfig,
    IMetricsFactory,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { v4 as uuidv4 } from 'uuid';
import {
    FlowMetricsResults,
    MetricsConversionStructure,
    Percentile,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { LeadTimeByColumnCalculator } from './leadTimeByColumn';
import { LeadTimeInWipCalculator } from './leadTimeInWip';
import { getDayForFilter } from '@/shared/utils/transforms/date';
import { mergeConfig } from '@/shared/utils/helpers';
import {
    MetricTrend,
    MetricTrendAnalyzerAndFormatter,
} from './metricAnalyzerAndFormatter';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    Item,
    ItemWithDeliveryStatus,
    WorkItem,
    WorkItemAging,
    WorkItemEstimation,
    WorkItemType,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { ModuleWorkItemType } from '@/core/domain/integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '../../logger/pino.service';
import { LeadTimeVariation } from '@/core/infrastructure/adapters/services/metrics/processMetrics/leadTimeVariation';
import { TeamMethodology } from '@/shared/domain/enums/team-methodology.enum';
import { LeadTimeItemTypeCalculator } from './leadTimeItemType';
import { LeadTimeFormat } from '@/shared/utils/formatters/leadTime';
import * as moment from 'moment-timezone';
import { LeadTimeByItemTypeHistory } from '../saveHistory/flowMetrics/leadTimeByItemType';
import { LeadTimeByColumnHistory } from '../saveHistory/flowMetrics/leadTimeByColumn';
import { ThroughputHistory } from '../saveHistory/flowMetrics/throughput';
import { BugRatioHistory } from '../saveHistory/flowMetrics/bugRatio';
import { LeadTimeHistory } from '../saveHistory/flowMetrics/leadTime';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { DeliveryCapacityHistory } from '../saveHistory/flowMetrics/deliveryCapacity';
import { generateFlowMetricsConfig } from '@/shared/utils/metrics/generateFlowMetricsConfig.utils';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';

//#region Types
type TodoDateResult = {
    date: Date;
    observation: string;
};

type WipDateResult = {
    date: Date;
    observation: string;
};

type EstimationPercentile = {
    estimationDate: string;
    noteAboutEstimation: string;
    isLate?: boolean;
    daysLateDelivery?: number;
};
//#endregion

export class MetricsFactory implements IMetricsFactory {
    constructor(
        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        private readonly projectManagementService: ProjectManagementService,

        private logger: PinoLoggerService,
    ) {}

    @ValidateProjectManagementIntegration()
    public async runDaily(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const endDate = new Date();

            const startDate = new Date(
                new Date(endDate.getTime() - 24 * 60 * 60 * 1000).setHours(
                    22,
                    0,
                    0,
                    0,
                ),
            );

            const metricsConfig: Partial<TeamMetricsConfig> = {
                considerAll: true,
                howManyHistoricalDays: 1,
            };

            await this.saveAllMetricsHistory(
                organizationAndTeamData,
                startDate,
                endDate,
                metricsConfig,
                false,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error while running daily metrics calculation',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    public async getWorkItemsDeliveryStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
        metrics: any,
        columnsConfig: ColumnsConfigResult,
        teamMethodology: string,
    ): Promise<ItemWithDeliveryStatus[]> {
        try {
            if (
                !teamMethodology ||
                teamMethodology?.toLowerCase() === TeamMethodology.KANBAN
            ) {
                return await this.getWorkItemsDeliveryStatusBasedOnMetrics(
                    workItems,
                    metrics,
                    columnsConfig,
                );
            }

            return await this.getWorkItemsDeliveryStatusBasedOnSprintFinalDate(
                organizationAndTeamData,
                workItems,
                metrics,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error while checking if the Work Items are On Track or Off Track',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    private async getWorkItemsDeliveryStatusBasedOnMetrics(
        wipWorkItems: Item[],
        metrics: any,
        columnsConfig: ColumnsConfigResult,
    ): Promise<ItemWithDeliveryStatus[]> {
        const leadTimeByColumn = await metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME_BY_COLUMN,
        ).value;

        const leadTimeInWip = await metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME_IN_WIP,
        ).value.total.percentiles.p75;

        const leadTime = await metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME,
        ).value;

        const wipWorkItemsKeys = wipWorkItems.map((item) => item.key);

        const filteredIssues = leadTime?.issues?.filter((issueObject) => {
            const issueKey = Object.keys(issueObject)[0];
            return wipWorkItemsKeys.includes(issueKey);
        });

        const filteredAndSortedWipColumns = columnsConfig.allColumns
            .filter((column) => column.column === 'wip')
            .sort((a, b) => a.order - b.order);

        filteredIssues?.forEach((issue) => {
            const issueKey = Object.keys(issue)[0];
            let totalLeadTime = 0;

            const columnsTime = issue[issueKey];

            Object.keys(columnsTime).forEach((columnName) => {
                const column = filteredAndSortedWipColumns.find(
                    (c) => c.name === columnName,
                );
                if (column) {
                    totalLeadTime += columnsTime[columnName];
                }
            });

            issue[issueKey].totalLeadTime = totalLeadTime;
        });

        const enhancedWipColumns = filteredAndSortedWipColumns.map((column) => {
            const leadTime = leadTimeByColumn[column.name] || 0;
            return { ...column, leadTime, leadTimeToEnd: 0 };
        });

        enhancedWipColumns.forEach((column, index, array) => {
            const sumOfLeadTimes = array
                .slice(index + 1)
                .reduce((sum, nextColumn) => sum + nextColumn.leadTime, 0);
            column.leadTimeToEnd = sumOfLeadTimes;
        });

        const workItemsWithLeadTimeToEnd = wipWorkItems.map((workItem) => {
            const column = enhancedWipColumns.find(
                (c) => c.id === workItem.status.id,
            );
            const issue = filteredIssues?.find(
                (issue) => Object.keys(issue)[0] === workItem.key,
            );
            const issueTotalLeadTime = issue
                ? issue[Object.keys(issue)[0]].totalLeadTime
                : 0;

            const leadTimeToEnd =
                column && column?.leadTimeToEnd ? column.leadTimeToEnd : 0;

            return {
                id: workItem.id,
                key: workItem.key,
                title: workItem.name,
                description: workItem.description,
                type: workItem.workItemType,
                actualStatus: workItem.status.name,
                assignedTo: workItem?.assignee?.userName,
                leadTimeToEnd,
                leadTimeUsed: issueTotalLeadTime,
                leadTimeUsedFormatted: LeadTimeFormat(issueTotalLeadTime),
                percentageLeadTimeAlreadyUsed:
                    issueTotalLeadTime <= leadTimeInWip
                        ? (issueTotalLeadTime / leadTimeInWip) * 100
                        : 0,
                leadTimeToEndWithLeadTimeAlreadyUsed:
                    issueTotalLeadTime + leadTimeToEnd,
                percentageLeadTimeExceeded:
                    issueTotalLeadTime > leadTimeInWip
                        ? (issueTotalLeadTime / leadTimeInWip) * 100 - 100
                        : 0,
                isLate: false, // Default value, issues are marked as late according to the method below
                onTrackFlag: '✅',
                estimatedDeliveryDate: new Date(),
                rank: workItem?.rank,
            };
        });

        for (let i = 0; i < workItemsWithLeadTimeToEnd.length; i++) {
            const estimatedDeliveryDate = new Date(
                Date.now() +
                    workItemsWithLeadTimeToEnd[i].leadTimeToEnd *
                        60 *
                        60 *
                        1000,
            );

            workItemsWithLeadTimeToEnd[i].estimatedDeliveryDate =
                estimatedDeliveryDate;

            if (workItemsWithLeadTimeToEnd[i].leadTimeUsed > leadTimeInWip) {
                workItemsWithLeadTimeToEnd[i].isLate = true;
                workItemsWithLeadTimeToEnd[i].onTrackFlag = '🚨';
                if (
                    workItemsWithLeadTimeToEnd[i].percentageLeadTimeExceeded < 0
                ) {
                    workItemsWithLeadTimeToEnd[i].percentageLeadTimeExceeded =
                        workItemsWithLeadTimeToEnd[i]
                            .percentageLeadTimeExceeded * -1;
                } else if (
                    workItemsWithLeadTimeToEnd[i].percentageLeadTimeExceeded ===
                    0
                ) {
                    workItemsWithLeadTimeToEnd[i].isLate = false;
                    workItemsWithLeadTimeToEnd[i].onTrackFlag = '⚠️';
                }
            } else if (
                workItemsWithLeadTimeToEnd[i]
                    .leadTimeToEndWithLeadTimeAlreadyUsed > leadTimeInWip
            ) {
                workItemsWithLeadTimeToEnd[i].onTrackFlag = '⚠️';
            }
        }

        return workItemsWithLeadTimeToEnd;
    }

    private async getWorkItemsDeliveryStatusBasedOnSprintFinalDate(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
        metrics: any,
    ): Promise<ItemWithDeliveryStatus[]> {
        try {
            const currentSprint =
                await this.projectManagementService.getCurrentSprintForTeam({
                    organizationAndTeamData,
                });

            if (!currentSprint || !currentSprint.endDate) {
                throw new Error('Current sprint or end date not found');
            }

            const sprintFinalDate = moment(currentSprint.endDate);

            const leadTimeInWipPercentiles = await metrics.find(
                (metric) => metric.type === METRICS_TYPE.LEAD_TIME_IN_WIP,
            )?.value?.total?.percentiles;

            if (!leadTimeInWipPercentiles) {
                throw new Error('Lead Time In WIP percentiles not found');
            }

            const workItemsEstimation = await this.estimateWorkItems(
                organizationAndTeamData,
                leadTimeInWipPercentiles,
                workItems,
            );

            const workItemsToReturn: ItemWithDeliveryStatus[] = [];

            for (const workItem of workItemsEstimation) {
                const workItemDeliveryDate = moment(
                    workItem?.p75?.estimationDate,
                    'DD/MM/YYYY',
                );
                const isLate = workItemDeliveryDate.isAfter(sprintFinalDate);
                workItemsToReturn.push({
                    id: workItem.id,
                    key: workItem.key,
                    title: workItem.title,
                    actualStatus: workItem.actualStatus,
                    assignedTo: workItem.assignedTo,
                    isLate: isLate,
                    onTrackFlag: isLate ? '🚨' : '✅',
                    estimatedDeliveryDate: workItemDeliveryDate.toDate(),
                    daysLateDelivery: workItem?.p75?.daysLateDelivery,
                    noteAboutEstimation: workItem?.p75?.noteAboutEstimation,
                    rank: workItem?.rank,
                });
            }

            return workItemsToReturn;
        } catch (error) {
            this.logger.error({
                message:
                    'Error while getting getWorkItemsDeliveryStatusBasedOnSprintFinalDate',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return []; // Returns an empty array in case of an error
        }
    }

    @ValidateProjectManagementIntegration()
    public async getRealTime(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const lastMetrics =
                await this.metricsService.findLastSavedMetricsToMetricsResults(
                    organizationAndTeamData.teamId,
                );

            if (!lastMetrics?.flowMetrics) {
                return null;
            }

            const metricsResult: FlowMetricsResults = lastMetrics.flowMetrics;

            return this.createMetricsToSave(
                metricsResult,
                organizationAndTeamData.teamId,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error while fetching the last saved metrics from the database',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    public async getRealTimeAndHistoricalMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConfig: Partial<FlowMetricsConfig>,
    ): Promise<MetricTrend[]> {
        try {
            const flowMetricsConfig = await generateFlowMetricsConfig({
                startDate: metricsConfig?.analysisPeriod?.startTime,
                endDate: metricsConfig?.analysisPeriod?.endTime,
            });

            const metricsResult =
                await this.metricsService.findLastSavedMetricsToMetricsResults(
                    organizationAndTeamData.teamId,
                    flowMetricsConfig,
                );

            const metrics = this.createMetricsToSave(
                metricsResult.flowMetrics,
                organizationAndTeamData.teamId,
            );

            return await this.getRealTimeAndHistorical(
                metrics,
                organizationAndTeamData.teamId,
                flowMetricsConfig,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error while running real-time and historical metrics calculation',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    public async getBugTypes(organizationAndTeamData: OrganizationAndTeamData) {
        const bugTypeIdentifiers =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Partial<WorkItemType>[]
            >(
                IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
                organizationAndTeamData,
            );

        return bugTypeIdentifiers;
    }

    public async getAgingForWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
    ): Promise<WorkItemAging[]> {
        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        const wipColumns = columnsConfig.wipColumns;

        const results: WorkItemAging[] = [];

        for (const workItem of workItems) {
            results.push(this.processAgingForWorkItem(wipColumns, workItem));
        }

        return results;
    }

    public async estimateWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        leadTimeInWipPercentiles: {
            p50: number;
            p75: number;
            p95: number;
        },
        workItems: Item[],
    ): Promise<WorkItemEstimation[]> {
        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        const todoColumns = columnsConfig.todoColumns;
        const wipColumns = columnsConfig.wipColumns;
        const doneColumns = columnsConfig.doneColumns;

        const results: WorkItemEstimation[] = [];

        for (const workItem of workItems) {
            results.push(
                await this.processDeliveryDateAndAgingForWorkItem(
                    todoColumns,
                    wipColumns,
                    doneColumns,
                    workItem,
                    leadTimeInWipPercentiles,
                    organizationAndTeamData,
                ),
            );
        }

        return results;
    }

    public getSecondToLastSavedMetricsByTeamIdAndMetricType(
        organizationAndTeamData: OrganizationAndTeamData,
        type: METRICS_TYPE,
    ) {
        return this.metricsService.getSecondToLastSavedMetricsByTeamIdAndMetricType(
            organizationAndTeamData.teamId,
            type,
        );
    }

    private createMetricsToSave(
        metricsResult: FlowMetricsResults,
        teamId: string,
    ): IMetrics[] {
        const leadTime: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTime,
            METRICS_TYPE.LEAD_TIME,
        );
        const leadTimeInWip: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTimeInWip,
            METRICS_TYPE.LEAD_TIME_IN_WIP,
        );
        const leadTimeByColumn: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTimeByColumn,
            METRICS_TYPE.LEAD_TIME_BY_COLUMN,
        );
        const throughput: IMetrics = this.createMetric(
            teamId,
            { value: metricsResult.throughput },
            METRICS_TYPE.THROUGHPUT,
        );
        const bugRatio: IMetrics = this.createMetric(
            teamId,
            metricsResult.bugRatio,
            METRICS_TYPE.BUG_RATIO,
        );
        const leadTimeInWipByItemType: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTimeInWipByItemType,
            METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE,
        );
        const leadTimeByItemType: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTimeByItemType,
            METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE,
        );

        return [
            leadTime,
            leadTimeInWip,
            leadTimeByColumn,
            throughput,
            bugRatio,
            leadTimeInWipByItemType,
            leadTimeByItemType,
        ];
    }

    private createMetric(teamId, value, type) {
        return {
            uuid: uuidv4(),
            value: value,
            type: type,
            team: { uuid: teamId },
            status: true,
        };
    }

    /**
     * Calculates the percentile of an array of values.
     *
     * @param {number[]} values - The array of values.
     * @param {number} percentile - The percentile to calculate.
     * @return {number} The calculated percentile.
     */
    private calculatePercentile(values: number[], percentile: number): number {
        values.sort((a, b) => a - b);
        const index = (percentile / 100) * (values.length - 1);

        if (Number.isInteger(index)) {
            return values[index];
        } else {
            const lower = values[Math.floor(index)];
            const upper = values[Math.ceil(index)];
            return lower + (upper - lower) * (index - Math.floor(index));
        }
    }

    // Function to calculate the average of an array
    private calculateAverage(arr: number[]): number {
        const average =
            arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const result = Number(average.toFixed(3));
        return isNaN(result) || result === null ? 0 : result;
    }

    // Function to get percentiles of an array
    private getPercentiles(arr: number[]): Percentile {
        return {
            p50: Number(this.calculatePercentile(arr, 50)?.toFixed(3)) || 0,
            p75: Number(this.calculatePercentile(arr, 75)?.toFixed(3)) || 0,
            p85: Number(this.calculatePercentile(arr, 85)?.toFixed(3)) || 0,
            p95: Number(this.calculatePercentile(arr, 95)?.toFixed(3)) || 0,
        };
    }

    async calculateForWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const metricsConfig = {
                howManyMetricsInThePast: 1,
            };

            const lastMetrics =
                await this.metricsService.findTeamMetricsHistoryWithConfigurableParams(
                    organizationAndTeamData.teamId,
                    metricsConfig,
                );

            if (!lastMetrics) {
                return null;
            }

            return {
                lastMetrics,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Error while calculating metrics in calculateForWorkItems',
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return null;
        }
    }

    /**
     * Calculate all metrics based on the given columns and configuration.
     *
     * @param {any[]} columns - the array of columns and issues to process
     * @param {ColumnsConfigResult} columnsConfig - the configuration for the columns
     * @param {boolean} considerAll - flag to consider all items (if false consider only workitems in done)
     * @return {MetricResults} the calculated metric results
     */
    public calculateAll(
        columns: any[],
        columnsConfig: ColumnsConfigResult,
        workItemTypes: WorkItemType[],
        bugTypeIdentifiers: any,
        todayDate?: Date,
        metricsConfig?: FlowMetricsConfig,
        throughputAnalysisEndDate?: string,
    ): FlowMetricsResults {
        try {
            const results = this.initResults();

            const allLeadTimes: { [key: string]: number[] } = {};
            const totalLeadTimes: number[] = [];

            for (const column of columns) {
                for (const workItem of column.workItems) {
                    this.processWorkItem(
                        workItem,
                        columnsConfig,
                        metricsConfig.considerAll,
                        results,
                        totalLeadTimes,
                        allLeadTimes,
                        todayDate,
                    );
                }
            }

            const { totalLeadTime, leadTimeInWip } =
                this.prepareDataToAggregateMetrics(
                    results,
                    allLeadTimes,
                    totalLeadTimes,
                    columnsConfig,
                );

            if (
                metricsConfig &&
                !metricsConfig?.analysisPeriod?.startTime &&
                !metricsConfig?.analysisPeriod?.endTime
            ) {
                const { today, dateAfterDaysInformed } = getDayForFilter(
                    7,
                    todayDate,
                );

                metricsConfig = {
                    ...metricsConfig,
                    analysisPeriod: {
                        // Calculate the start and end dates for a one-week period
                        startTime: new Date(dateAfterDaysInformed),
                        endTime: new Date(today),
                    },
                };
            }

            if (
                metricsConfig?.analysisPeriod?.startTime &&
                !!throughputAnalysisEndDate
            )
                metricsConfig.analysisPeriod.startTime = new Date(
                    throughputAnalysisEndDate,
                );

            // Calculate Throughput
            const totalThroughput = this.calculateThrouhputForAll(
                columns,
                columnsConfig,
                metricsConfig,
            );

            // Calculate the bug ratio
            const bugRatioCalculator = new BugRatioCalculator();
            bugRatioCalculator.setConfiguration(
                columns,
                columnsConfig.wipColumns,
                bugTypeIdentifiers,
            );

            const bugRatio = bugRatioCalculator.calculateBugRatioForAll();

            const formatResults = this.formatResults(
                totalLeadTime.average,
                totalLeadTime.percentiles,
                totalLeadTime.sum,
                results,
                leadTimeInWip.average,
                leadTimeInWip.percentiles,
                leadTimeInWip.sum,
                leadTimeInWip.deviation,
                bugRatio,
                totalThroughput,
            );

            if (!formatResults) {
                throw new Error('Failed to format results');
            }

            const { formattedLeadTime, formattedLeadTimeInWip } = formatResults;

            // Calculate formatted leadTimeByItemType
            const leadTimeByItemType = new LeadTimeItemTypeCalculator();
            leadTimeByItemType.setConfiguration(
                columns,
                formattedLeadTime,
                workItemTypes,
            );

            const leadTimeByItemTypeGeneral =
                leadTimeByItemType.calculateLeadTimeByItemTypeForAll();

            const leadTimeInWipByItemType =
                leadTimeByItemType.calculateLeadTimeInWipByItemTypeForAll(
                    columnsConfig.wipColumns,
                    columnsConfig.allColumns,
                );

            return {
                leadTime: formattedLeadTime,
                leadTimeByColumn: results.leadTimeByColumn,
                leadTimeInWip: formattedLeadTimeInWip,
                leadTimeInWipByItemType,
                leadTimeByItemType: leadTimeByItemTypeGeneral,
                throughput: totalThroughput,
                bugRatio: bugRatio,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error while calculating metrics in calculateAll',
                context: MetricsFactory.name,
                error: error,
            });
            throw error;
        }
    }

    private processAgingForWorkItem(
        todoColumns,
        workItem: Item,
    ): WorkItemAging {
        const { date: todoDate, observation: todoNote } = this.findToDoDate(
            workItem,
            todoColumns,
        );

        if (todoDate) {
            // Adds the predicted delivery dates to the list, along with the issue ID
            return {
                key: workItem.key,
                startDate: moment(todoDate).format('DD/MM/YYYY'),
                aging: moment().diff(moment(todoDate), 'days'),
                noteAboutAgingCard: todoNote,
            };
        }

        return {
            key: workItem.key,
            aging: null,
            startDate: null,
        };
    }

    private async processDeliveryDateAndAgingForWorkItem(
        todoColumns,
        wipColumns,
        doneColumns,
        workItem: Item,
        leadTimeInWipPercentiles,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<WorkItemEstimation> {
        const { date: todoDate } = this.findToDoDate(workItem, todoColumns);

        const { date: wipDate, observation: wipNote } = this.findWipDate(
            workItem,
            wipColumns,
        );

        // If the item is in the done column, there is no need to estimate the delivery date
        if (doneColumns.includes(workItem.status.id)) {
            return {
                id: workItem.id,
                key: workItem.key,
                title: workItem.name,
                actualStatus: workItem.status?.name,
                assignedTo: workItem.assignee?.userName,
                startDate: null,
                aging: null,
                p50: null,
                p75: null,
                p95: null,
                message:
                    "Item already in 'Done' column, no need to estimate delivery date",
            };
        }

        if (todoDate && wipDate) {
            const p50EstimationDate = moment(
                wipDate.getTime() +
                    leadTimeInWipPercentiles.p50 * 60 * 60 * 1000,
            );

            const p75EstimationDate = moment(
                wipDate.getTime() +
                    leadTimeInWipPercentiles.p75 * 60 * 60 * 1000,
            );

            const p95EstimationDate = moment(
                wipDate.getTime() +
                    leadTimeInWipPercentiles.p95 * 60 * 60 * 1000,
            );

            const deliveryDates = {
                startDate: moment(todoDate).format('DD/MM/YYYY'),
                aging: moment().diff(moment(todoDate), 'days'),
                p50: await this.createPercentileEstimation(
                    p50EstimationDate,
                    wipDate,
                    wipNote,
                    leadTimeInWipPercentiles.p50,
                    organizationAndTeamData,
                ),
                p75: await this.createPercentileEstimation(
                    p75EstimationDate,
                    wipDate,
                    wipNote,
                    leadTimeInWipPercentiles.p75,
                    organizationAndTeamData,
                ),
                p95: await this.createPercentileEstimation(
                    p95EstimationDate,
                    wipDate,
                    wipNote,
                    leadTimeInWipPercentiles.p95,
                    organizationAndTeamData,
                ),
            };

            return {
                id: workItem.id,
                key: workItem.key,
                title: workItem.name,
                actualStatus: workItem.status?.name,
                assignedTo: workItem.assignee?.userName,
                ...deliveryDates,
            };
        }

        return {
            id: workItem.id,
            key: workItem.key,
            title: workItem.name,
            actualStatus: workItem.status?.name,
            assignedTo: workItem.assignee?.userName,
            startDate: null,
            aging: null,
            p50: null,
            p75: null,
            p95: null,
        };
    }

    private processWorkItem(
        workItem: any,
        columnsConfig: ColumnsConfigResult,
        considerAll: boolean,
        results: any,
        totalLeadTimes: any,
        allLeadTimes: any,
        todayDate?: Date,
    ) {
        try {
            const hasDoneEntry = workItem.changelog.some(
                (entry: { movements: any[] }) =>
                    entry.movements.some(
                        (item) =>
                            item.field === 'status' &&
                            columnsConfig.doneColumns.some(
                                (done) => done === item.toColumnId,
                            ),
                    ),
            );

            // If the flag to consider all tasks is false, we do not calculate lead times for incomplete tasks
            if (!considerAll && !hasDoneEntry) {
                return;
            }

            const leadTimeCalculator = new LeadTimeCalculator();
            leadTimeCalculator.setConfiguration(
                workItem.changelog,
                columnsConfig,
                considerAll,
                new Date(workItem.workItemCreatedAt),
                todayDate,
            );

            const individualLeadTimeWithoutZeros =
                leadTimeCalculator.calculateLeadTime();

            const individualLeadTime = leadTimeCalculator.handleSkippedColumns(
                individualLeadTimeWithoutZeros,
            );

            if (individualLeadTime.totalLeadTime !== undefined) {
                totalLeadTimes.push(individualLeadTime.totalLeadTime);
            }

            for (const [colName, time] of Object.entries(
                individualLeadTime.leadTimes,
            )) {
                if (!allLeadTimes[colName]) {
                    allLeadTimes[colName] = [];
                }
                allLeadTimes[colName].push(time);
            }

            results.leadTime[workItem.key] = {
                ...individualLeadTime.leadTimes,
            };

            const leadTimeInWipCalculator = new LeadTimeInWipCalculator();
            leadTimeInWipCalculator.setConfiguration(
                workItem.changelog,
                columnsConfig,
                new Date(workItem.workItemCreatedAt),
                todayDate,
            );

            // Calculating lead time in WIP
            const individualLeadTimeInWip =
                leadTimeInWipCalculator.calculateLeadTimeInWip();
            if (individualLeadTimeInWip !== undefined) {
                results.leadTimeInWip[workItem.key] = individualLeadTimeInWip;
            }
        } catch (error) {
            this.logger.error({
                message: `Error while processing issue ${workItem.key} \n ${error}`,
                context: MetricsFactory.name,
                error: error,
                metadata: {
                    workItemKey: workItem.key,
                },
            });
        }
    }

    private initResults() {
        const results: {
            leadTime: { [key: string]: { [key: string]: number } };
            leadTimeByColumn: {
                [key: string]: number;
            };
            average: { [key: string]: number };
            percentiles: {
                [key: string]: {
                    p50: number;
                    p75: number;
                    p85: number;
                    p95: number;
                };
            };
            leadTimeInWip: { [key: string]: number };
            predictedDeliveryDates: {
                [key: string]: {
                    p50: Date;
                    p75: Date;
                    p95: Date;
                };
            };
            bugRatio: {
                [key: string]: {
                    value: number;
                };
            };
        } = {
            leadTime: {},
            leadTimeByColumn: {},
            average: {},
            percentiles: {},
            leadTimeInWip: {},
            bugRatio: {},
            predictedDeliveryDates: {},
        };

        return results;
    }

    private prepareDataToAggregateMetrics(
        results,
        allLeadTimes,
        totalLeadTimes,
        columnsConfig,
    ) {
        // Calculate average and percentiles of leadTime for each column
        for (const colName in allLeadTimes) {
            results.average[colName] = this.calculateAverage(
                allLeadTimes[colName],
            );
            results.percentiles[colName] = this.getPercentiles(
                allLeadTimes[colName],
            );
        }

        const totalLeadTimeAverage = this.calculateAverage(totalLeadTimes);
        const totalLeadTimePercentiles = this.getPercentiles(totalLeadTimes);
        const totalLeadTime = totalLeadTimes.reduce(
            (accumulator, currentValue) => accumulator + currentValue,
            0,
        );

        const allLeadTimeInWip: number[] = Object.values(results.leadTimeInWip);
        const leadTimeInWipAverage = this.calculateAverage(allLeadTimeInWip);
        const leadTimeInWipPercentiles = this.getPercentiles(allLeadTimeInWip);
        const totalLeadTimeInWIP = allLeadTimeInWip.reduce(
            (accumulator, currentValue) => accumulator + currentValue,
            0,
        );

        const leadtimeInWipStandardDeviationCalculator =
            new LeadTimeVariation();

        const leadTimeDeviation =
            leadtimeInWipStandardDeviationCalculator.calculateStandardDeviationOfVariations(
                Object.values(results.leadTimeInWip),
            );

        const leadTimeByColumnCalculator = new LeadTimeByColumnCalculator();

        leadTimeByColumnCalculator.setConfiguration(
            columnsConfig,
            results.leadTime,
        );

        const leadTimeByColumn =
            leadTimeByColumnCalculator.calculateWipLeadTime();

        if (leadTimeByColumn !== undefined) {
            results.leadTimeByColumn = leadTimeByColumn;
        }

        if (leadTimeByColumn !== undefined) {
            results.leadTimeByColumn = leadTimeByColumn;
        }

        return {
            totalLeadTime: {
                average: totalLeadTimeAverage,
                percentiles: totalLeadTimePercentiles,
                sum: totalLeadTime,
            },
            leadTimeInWip: {
                total: allLeadTimeInWip,
                average: leadTimeInWipAverage,
                percentiles: leadTimeInWipPercentiles,
                sum: totalLeadTimeInWIP,
                deviation: leadTimeDeviation,
            },
        };
    }

    private formatResults(
        totalLeadTimeAverage,
        totalLeadTimePercentiles,
        totalLeadTimeSum,
        results,
        leadTimeInWipAverage,
        leadTimeInWipPercentiles,
        leadTimeInWipSum,
        leadTimeInWipDeviation,
        bugRatio,
        totalThroughput,
    ) {
        // Reformat leadTime to the desired structure
        const formattedLeadTime: any = {
            issues: [],
            columns: [],
            total: {
                average: totalLeadTimeAverage,
                percentiles: totalLeadTimePercentiles,
                sum: totalLeadTimeSum,
            },
        };

        // Add issues to the formattedLeadTime.issues array
        for (const [issueKey, leadTimeData] of Object.entries(
            results.leadTime,
        )) {
            formattedLeadTime.issues.push({ [issueKey]: leadTimeData });
        }

        // Add columns to the formattedLeadTime.columns array
        for (const colName in results.average) {
            formattedLeadTime.columns.push({
                column: colName,
                average: results.average[colName],
                percentile: {
                    p50: results.percentiles[colName]?.p50,
                    p75: results.percentiles[colName]?.p75,
                    p85: results.percentiles[colName]?.p85,
                    p95: results.percentiles[colName]?.p95,
                },
            });

            // Reformat leadTimeInWip to the desired structure
            const formattedLeadTimeInWip: any = {
                issues: [],
                total: {
                    average: leadTimeInWipAverage,
                    percentiles: leadTimeInWipPercentiles,
                    sum: leadTimeInWipSum,
                    deviation: leadTimeInWipDeviation,
                },
            };

            // Add issues to the formattedLeadTimeInWip.issues array
            for (const [issueKey, leadTimeInWipData] of Object.entries(
                results.leadTimeInWip,
            )) {
                formattedLeadTimeInWip.issues.push({
                    key: issueKey,
                    average: leadTimeInWipData,
                });
            }

            return {
                bugRatio,
                formattedLeadTime,
                totalThroughput,
                formattedLeadTimeInWip,
                leadTimeInWipPercentiles,
                totalLeadTimeAverage,
            };
        }
    }

    private calculateThrouhputForAll(columns, columnsConfig, analysisPeriod) {
        const throughputCalculator = new ThroughputCalculator();
        const period = analysisPeriod.analysisPeriod || analysisPeriod;

        throughputCalculator.setConfiguration(
            columns,
            columnsConfig.doneColumns,
            {
                startTime: period.startTime,
                endTime: period.endTime,
            },
        );

        return throughputCalculator.calculateThroughput();
    }

    private async getRealTimeAndHistorical(
        metricRealTime: IMetrics[],
        teamId: string,
        metricsConfig: FlowMetricsConfig,
    ): Promise<any> {
        const metricTrendAnalyzerAndFormatter =
            new MetricTrendAnalyzerAndFormatter();

        const metricsHistory: IMetrics[] =
            (await this.metricsService.findTeamMetricsHistoryWithConfigurableParams(
                teamId,
                metricsConfig,
            )) || [];

        const metricRealTimeFormatted = metricRealTime.map((metric) => ({
            ...metric,
            _uuid: metric.uuid,
            _type: metric.type,

            _value: metric.value,
            _createdAt: new Date(),
        }));

        metricsHistory.push(...metricRealTimeFormatted);

        const predictedDeliveryDates =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.PREDICTED_DELIVERY_DATES,
                metricsHistory,
            );

        const bugRatio =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.BUG_RATIO,
                metricsHistory,
            );

        const throughput =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.THROUGHPUT,
                metricsHistory,
            );

        const leadTime =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME,
                metricsHistory,
            );

        const leadTimeInWip =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_IN_WIP,
                metricsHistory,
            );

        const leadTimeByColumn =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                metricsHistory,
            );

        const leadTimeByItemType =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE,
                metricsHistory,
            );

        const leadTimeInWipByItemType =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE,
                metricsHistory,
            );

        return {
            leadTime,
            leadTimeInWip,
            leadTimeByColumn,
            predictedDeliveryDates,
            bugRatio,
            throughput,
            leadTimeByItemType,
            leadTimeInWipByItemType,
        };
    }

    private async getConfigWorkItemTypes(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<WorkItemType[]> {
        try {
            const workItemTypes =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ModuleWorkItemType[]
                >(
                    IntegrationConfigKey.MODULE_WORKITEMS_TYPES,
                    organizationAndTeamData,
                );

            const workItemTypesFiltered = workItemTypes?.find(
                (workItemType) =>
                    workItemType.name === MODULE_WORKITEMS_TYPES.DEFAULT,
            ).workItemTypes;

            return workItemTypesFiltered;
        } catch (error) {
            console.log(error);
        }
    }

    /**
     * Calculate the difference between two metrics.
     *
     * @param {IMetrics[]} metrics - array of metrics
     * @param {IMetrics} lastMetric - second to last metric object
     * @param {METRICS_TYPE} metricToCalc - type of metric to calculate
     * @return {Object} object containing metric, second to last metric, and difference metric
     */
    public calcDiff(
        actualMetric: IMetrics[],
        lastMetric: IMetrics,
        metricToCalc: METRICS_TYPE,
    ) {
        const metric: IMetrics = actualMetric.find(
            (metric) => metric.type === metricToCalc,
        );

        if (!metric || !lastMetric?.type) {
            return {
                metric: metric ?? null,
                lastMetric,
                diffMetric: 0,
            };
        }

        let diffMetric = 0;

        if (metricToCalc === METRICS_TYPE.LEAD_TIME_IN_WIP) {
            diffMetric =
                ((lastMetric?.value?.total?.percentiles?.p75 -
                    metric?.value?.total?.percentiles?.p75) /
                    lastMetric?.value?.total?.percentiles?.p75) *
                100;

            if (
                (metric?.value?.total?.percentiles?.p75 === 0 ||
                    lastMetric?.value?.total?.percentiles?.p75 === 0) &&
                lastMetric?.value?.total?.percentiles?.p75 -
                    metric?.value?.total?.percentiles?.p75 ===
                    0
            ) {
                diffMetric = 0;
            }
        }
        if (metricToCalc === METRICS_TYPE.THROUGHPUT) {
            diffMetric =
                ((lastMetric?.value?.value - metric?.value?.value) /
                    lastMetric?.value?.value) *
                100;

            if (
                metric?.value?.value === 0 ||
                lastMetric?.value?.value === 0 ||
                lastMetric?.value?.value - metric?.value?.value === 0
            ) {
                diffMetric = 0;
            }
        }

        return {
            metric,
            lastMetric,
            diffMetric,
        };
    }

    //#region Metrics History
    public async saveAllMetricsHistory(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: Date,
        endDate: Date,
        metricsConfig: Partial<TeamMetricsConfig>,
        generateHistory: boolean = true,
    ) {
        try {
            const config = await this.getConfiguration(organizationAndTeamData);

            const historicalStartDate = new Date(startDate);
            historicalStartDate.setDate(
                historicalStartDate.getDate() -
                    metricsConfig?.howManyHistoricalDays,
            );

            let workItems;

            if (generateHistory) {
                workItems = await this.getHistoricalWorkItems(
                    organizationAndTeamData,
                    historicalStartDate,
                    endDate,
                );
            } else {
                workItems = await this.projectManagementService.getWorkItems({
                    organizationAndTeamData,
                    filters: {
                        workItemTypes: config.workItemTypes,
                        showDescription: false,
                    },
                    useCache: false,
                });
            }

            metricsConfig.considerAll = metricsConfig.considerAll ?? true;

            await this.saveBugRatioMetrics(
                workItems,
                config,
                startDate,
                endDate,
                organizationAndTeamData.teamId,
            );

            const { allMetricResults, allDates } =
                await this.calculateDailyMetrics(
                    workItems,
                    config,
                    startDate,
                    endDate,
                    metricsConfig,
                    generateHistory,
                );

            await this.saveLeadTimeMetrics(
                allMetricResults,
                allDates,
                organizationAndTeamData.teamId,
            );

            await this.saveLeadTimeByItemTypeMetrics(
                allMetricResults,
                allDates,
                organizationAndTeamData.teamId,
            );

            await this.saveLeadTimeByColumnMetrics(
                allMetricResults,
                allDates,
                organizationAndTeamData.teamId,
            );

            await this.saveThroughputMetrics(
                workItems,
                config,
                startDate,
                endDate,
                organizationAndTeamData.teamId,
                generateHistory,
            ).then(async (throughputMetrics) => {
                await this.saveDeliveryCapacityMetrics(
                    workItems,
                    config,
                    startDate,
                    endDate,
                    organizationAndTeamData.teamId,
                    generateHistory,
                    throughputMetrics,
                );
            });
        } catch (error) {
            this.logError(
                'Error while saving metrics history',
                error,
                organizationAndTeamData,
            );
            throw error;
        }
    }

    private async getConfiguration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const [workItemTypes, columnsConfig, bugTypeIdentifiers] =
            await Promise.all([
                this.getConfigWorkItemTypes(organizationAndTeamData),
                this.projectManagementService.getColumnsConfig(
                    organizationAndTeamData,
                ),
                this.getBugTypes(organizationAndTeamData),
            ]);

        if (!workItemTypes || !columnsConfig || !bugTypeIdentifiers) {
            throw new Error(
                'Unable to calculate metrics, missing default configuration.',
            );
        }

        return { workItemTypes, columnsConfig, bugTypeIdentifiers };
    }

    private async getHistoricalWorkItems(
        organizationAndTeamData: OrganizationAndTeamData,
        historicalStartDate: Date,
        endDate: Date,
    ) {
        return this.projectManagementService.getWorkItems({
            organizationAndTeamData,
            filters: {
                workItemTypes: await this.getConfigWorkItemTypes(
                    organizationAndTeamData,
                ),
                period: {
                    startDate: historicalStartDate.toISOString(),
                    endDate: endDate.toISOString(),
                },
                showDescription: false,
            },
            useCache: false,
            generateHistory: true,
        });
    }

    private async calculateDailyMetrics(
        workItems,
        config,
        startDate,
        endDate,
        metricsConfig,
        generateHistory: boolean = true,
    ) {
        const allMetricResults: FlowMetricsResults[] = [];
        const allDates: Date[] = [];

        for (
            let currentDate = new Date(startDate);
            currentDate <= endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            try {
                let analysisStartDate: Date;
                let filteredWorkItems: WorkItem[];

                if (generateHistory) {
                    analysisStartDate = new Date(currentDate);
                    analysisStartDate.setDate(analysisStartDate.getDate() - 90);

                    filteredWorkItems = this.filterWorkItemsForDate(
                        workItems,
                        analysisStartDate,
                        currentDate,
                    );
                } else {
                    analysisStartDate = startDate;

                    filteredWorkItems = workItems;

                    currentDate.setDate(currentDate.getDate() + 1);
                }

                const metricsResult = this.calculateAll(
                    filteredWorkItems,
                    config.columnsConfig,
                    config.workItemTypes,
                    config.bugTypeIdentifiers,
                    currentDate,
                    {
                        considerAll: metricsConfig.considerAll ?? true,
                        ...metricsConfig,
                        analysisPeriod: {
                            startTime: analysisStartDate,
                            endTime: currentDate,
                        },
                    },
                );

                allMetricResults.push(metricsResult);
                allDates.push(new Date(currentDate));
            } catch (error) {
                this.logError('Error while calculating daily metrics', error, {
                    date: currentDate,
                });
            }
        }

        return { allMetricResults, allDates };
    }

    private async saveThroughputMetrics(
        workItems,
        config,
        startDate,
        endDate,
        teamId,
        generateHistory: boolean = true,
    ) {
        try {
            const throughputMetrics =
                new ThroughputHistory().prepareDataToBulkCreate({
                    workItems,
                    columnsConfig: config.columnsConfig,
                    startDate,
                    endDate,
                    teamId,
                    generateHistory,
                });
            await this.metricsService.bulkCreate(throughputMetrics);

            return throughputMetrics;
        } catch (error) {
            this.logError('Error while processing Throughput metrics', error, {
                teamId,
            });
        }
    }

    private async saveBugRatioMetrics(
        workItems,
        config,
        startDate,
        endDate,
        teamId,
    ) {
        try {
            const bugRatioMetrics =
                new BugRatioHistory().prepareDataToBulkCreate({
                    workItems,
                    columnsConfig: config.columnsConfig,
                    bugTypeIdentifiers: config.bugTypeIdentifiers,
                    startDate,
                    endDate,
                    teamId,
                });
            await this.metricsService.bulkCreate(bugRatioMetrics);
        } catch (error) {
            this.logError('Error while processing Bug Ratio metrics', error, {
                teamId,
            });
        }
    }

    private async saveLeadTimeMetrics(allMetricResults, allDates, teamId) {
        try {
            const leadTimeMetrics =
                new LeadTimeHistory().prepareDataToBulkCreate(
                    allMetricResults,
                    teamId,
                    allDates,
                );
            await this.metricsService.bulkCreate(leadTimeMetrics);
        } catch (error) {
            this.logError('Error while processing Lead Time metrics', error, {
                teamId,
            });
        }
    }

    private async saveLeadTimeByItemTypeMetrics(
        allMetricResults,
        allDates,
        teamId,
    ) {
        try {
            const leadTimeByItemTypeMetrics =
                new LeadTimeByItemTypeHistory().prepareDataToBulkCreate(
                    allMetricResults,
                    teamId,
                    allDates,
                );
            await this.metricsService.bulkCreate(leadTimeByItemTypeMetrics);
        } catch (error) {
            this.logError(
                'Error while processing Lead Time metrics by Item Type',
                error,
                { teamId },
            );
        }
    }

    private async saveLeadTimeByColumnMetrics(
        allMetricResults,
        allDates,
        teamId,
    ) {
        try {
            const leadTimeByColumnMetrics =
                new LeadTimeByColumnHistory().prepareDataToBulkCreate(
                    allMetricResults,
                    teamId,
                    allDates,
                );
            await this.metricsService.bulkCreate(leadTimeByColumnMetrics);
        } catch (error) {
            this.logError(
                'Error while processing Lead Time metrics by Column',
                error,
                { teamId },
            );
        }
    }

    private async saveDeliveryCapacityMetrics(
        workItems: WorkItem[],
        config: any,
        startDate: Date,
        endDate: Date,
        teamId: string,
        generateHistory: boolean = true,
        throughputData: any[],
    ) {
        try {
            const deliveryCapacityMetrics =
                new DeliveryCapacityHistory().prepareDataToBulkCreate({
                    workItems,
                    columnsConfig: config.columnsConfig,
                    startDate,
                    endDate,
                    teamId,
                    generateHistory,
                    throughputData,
                });
            await this.metricsService.bulkCreate(deliveryCapacityMetrics);
        } catch (error) {
            this.logError(
                'Error while processing Delivery Capacity metrics',
                error,
                {
                    teamId,
                },
            );
        }
    }

    private logError(message: string, error: any, metadata: any) {
        this.logger.error({
            message,
            context: MetricsFactory.name,
            error,
            metadata,
        });
    }

    private filterWorkItemsForDate(
        workItems: WorkItem[],
        startDate: Date,
        endDate: Date,
    ): WorkItem[] {
        return workItems
            .map((column) => ({
                ...column,
                workItems: column.workItems.filter((item) => {
                    const itemDate = new Date(item.workItemCreatedAt);
                    return itemDate >= startDate && itemDate <= endDate;
                }),
            }))
            .filter((column) => column.workItems.length > 0);
    }
    //#endregion

    public async getFlowMetricsHistoryWithConfigurableParams(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConversionStructure?: MetricsConversionStructure,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Promise<any> {
        const defaultMetricsConfig: TeamMetricsConfig = {
            howManyMetricsInThePast:
                metricsConfig?.howManyMetricsInThePast ?? 1,
            daysInterval: metricsConfig?.daysInterval ?? 7,
            weekDay: metricsConfig?.weekDay ?? 0,
        };

        const mergedConfig = mergeConfig(defaultMetricsConfig, metricsConfig);

        const metricsResult =
            await this.metricsService.findTeamMetricsHistoryWithConfigurableParams(
                organizationAndTeamData.teamId,
                mergedConfig,
                METRICS_CATEGORY.FLOW_METRICS,
            );

        if (!metricsResult?.length) {
            return null;
        }

        switch (metricsConversionStructure) {
            case MetricsConversionStructure.METRICS_TREND:
                return this.metricsService.MapToMetricsTrend(metricsResult);
            case MetricsConversionStructure.I_METRICS:
                return this.metricsService.MapToIMetrics(
                    metricsResult,
                    organizationAndTeamData?.teamId,
                );
            default:
                return metricsResult;
        }
    }

    //#region Helper Functions
    private findToDoDate(
        workItem: Item,
        todoColumns: string[],
    ): TodoDateResult {
        if (workItem.changelog) {
            const todoEntries = workItem.changelog
                .filter((entry) =>
                    entry.movements.some(
                        (movement) =>
                            movement.field === 'status' &&
                            todoColumns.includes(movement.toColumnId),
                    ),
                )
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );

            if (todoEntries.length > 0) {
                const todoDate = new Date(todoEntries[0].createdAt);
                return {
                    date: todoDate,
                    observation: `The item entered ToDo on ${moment(todoDate).format('DD/MM/YYYY')}`,
                };
            }
        }

        // If no entry in ToDo was found in the changelog, use the creation date
        const creationDate = new Date(workItem.workItemCreatedAt);
        return {
            date: creationDate,
            observation: `The item did not pass through any ToDo column. Using the creation date: ${moment(creationDate).format('DD/MM/YYYY')}`,
        };
    }

    private findWipDate(workItem: Item, wipColumns: string[]): WipDateResult {
        if (workItem.changelog) {
            const wipEntries = workItem.changelog
                .filter((entry) =>
                    entry.movements.some(
                        (movement) =>
                            movement.field === 'status' &&
                            wipColumns.includes(movement.toColumnId),
                    ),
                )
                .sort(
                    (a, b) =>
                        new Date(a.createdAt).getTime() -
                        new Date(b.createdAt).getTime(),
                );

            if (wipEntries.length > 0) {
                const wipDate = new Date(wipEntries[0].createdAt);
                return {
                    date: wipDate,
                    observation: `The item entered WIP on ${moment(wipDate).format('DD/MM/YYYY')}`,
                };
            }
        }

        // If no WIP entry was found, use tomorrow as the estimated date
        const tomorrow = moment().add(1, 'days').startOf('day').toDate();
        return {
            date: tomorrow,
            observation: `The item has not yet entered WIP. To simulate the estimates, we are considering that it will enter WIP tomorrow on ${moment(tomorrow).format('DD/MM/YYYY')}`,
        };
    }

    private async createPercentileEstimation(
        estimationDate: moment.Moment,
        wipDate: Date,
        wipNote: string,
        percentileHours: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<EstimationPercentile> {
        const isLate = moment().isAfter(
            moment(wipDate.getTime() + percentileHours * 60 * 60 * 1000),
        );

        const timezone = (
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.TIMEZONE_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;

        const baseEstimation = {
            estimationDate: estimationDate.tz(timezone).format('DD/MM/YYYY'),
            noteAboutEstimation: wipNote,
        };

        if (isLate) {
            return {
                ...baseEstimation,
                isLate,
                daysLateDelivery: moment().diff(moment(estimationDate), 'days'),
            };
        }

        return baseEstimation;
    }
    //#endregion
}
