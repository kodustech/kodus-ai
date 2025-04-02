import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    IMetricsRepository,
    METRICS_REPOSITORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.repository.contract';
import { IMetricsService } from '@/core/domain/metrics/contracts/metrics.service.contract';
import { MetricsEntity } from '@/core/domain/metrics/entities/metrics.entity';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { MetricsModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/metrics.model';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { FindOneOptions } from 'typeorm';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { STATUS } from '@/config/types/database/status.type';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { ThroughputCalculator } from './processMetrics/throughput';
import { BugRatioCalculator } from './processMetrics/bugRatio';
import { LeadTimeCalculator } from './processMetrics/leadTime';
import { LeadTimeInWipCalculator } from './processMetrics/leadTimeInWip';
import { DeployFrequencyCalculator } from './processMetrics/doraMetrics/deployFrequency';
import { LeadTimeByColumnCalculator } from './processMetrics/leadTimeByColumn';
import { LeadTimeForChangeCalculator } from './processMetrics/doraMetrics/leadTimeForChange';
import { LeadTimeItemTypeCalculator } from './processMetrics/leadTimeItemType';

import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import {
    DoraMetricsResults,
    FlowMetricsResults,
    MetricsConversionStructure,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import {
    MetricTrend,
    MetricTrendAnalyzerAndFormatter,
} from './processMetrics/metricAnalyzerAndFormatter';
import { generateFlowMetricsConfig } from '@/shared/utils/metrics/generateFlowMetricsConfig.utils';
import { generateDoraMetricsConfig } from '@/shared/utils/metrics/generateDoraMetricsConfig.utils';
import {
    DeliveryCapacityCalculator,
    NewItemsFrom,
} from './processMetrics/deliveryCapacity';
import { FlowEfficiencyCalculator } from './processMetrics/flowEfficiency';
import { MetricsAnalysisInterval } from '@/shared/utils/metrics/metricsAnalysisInterval.enum';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import {
    CodeManagementConnectionStatus,
    ValidateCodeManagementIntegration,
} from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import { PinoLoggerService } from '../logger/pino.service';
import { Timezone } from '@/shared/domain/enums/timezones.enum';

@Injectable()
export class MetricsService implements IMetricsService {
    constructor(
        @Inject(METRICS_REPOSITORY_TOKEN)
        private readonly metricsRepository: IMetricsRepository,

        @Inject(forwardRef(() => METRICS_FACTORY_TOKEN))
        private readonly metricsFactory: IMetricsFactory,

        @Inject(forwardRef(() => DORA_METRICS_FACTORY_TOKEN))
        private readonly doraMetricsFactory: IDoraMetricsFactory,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        private readonly codeManagementService: CodeManagementService,
        private readonly projectManagementService: ProjectManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    //#region Find
    //Called only in the Organization Metrics Service
    findOne(where: FindOneOptions<MetricsModel>): Promise<MetricsEntity> {
        return this.metricsRepository.findOne(where);
    }

    //Called only in the Organization Metrics Service
    find(filter: Partial<IMetrics>): Promise<MetricsEntity[]> {
        return this.metricsRepository.find(filter);
    }

    //Called only through the Factory classes (Flow and Dora)
    public async findTeamMetricsHistoryWithConfigurableParams(
        teamId: string,
        metricsConfig?: Partial<TeamMetricsConfig>,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<MetricsEntity[]> {
        return this.metricsRepository.findTeamMetricsHistoryWithConfigurableParams(
            teamId,
            metricsConfig,
            metricsCategory,
        );
    }

    //Called only through the Flow Metrics Factory
    public async getSecondToLastSavedMetricsByTeamIdAndMetricType(
        teamId: string,
        type: METRICS_TYPE,
    ) {
        return this.metricsRepository.getSecondToLastSavedMetricsByTeamIdAndMetricType(
            teamId,
            type,
        );
    }

    //Called only through the Factory classes (Flow and Dora)
    public async findLastSavedMetricsToMetricsResults(teamId: string): Promise<{
        flowMetrics: FlowMetricsResults;
        doraMetrics: DoraMetricsResults;
    }> {
        const metricsConfig = await generateFlowMetricsConfig({
            interval: MetricsAnalysisInterval.LAST_WEEK,
        });

        const savedMetrics = await this.findLastSavedMetricsByTeamId(
            teamId,
            metricsConfig,
        );

        if (!savedMetrics || savedMetrics.length === 0) {
            return null;
        }

        const flowMetrics = await this.mapLastSavedFlowMetrics(savedMetrics);
        const doraMetrics = await this.mapLastSavedDoraMetrics(savedMetrics);

        return { flowMetrics, doraMetrics };
    }
    //#endregion

    //#region Write (Create/Delete)
    //Called only through the Dora Metrics Factory
    public create(metricsEntity: IMetrics): Promise<MetricsEntity> {
        return this.metricsRepository.create(metricsEntity);
    }

    //Called only through the Factory classes (Flow and Dora)
    public async bulkCreate(
        metricsEntity: IMetrics[],
    ): Promise<MetricsEntity[]> {
        return await this.metricsRepository.bulkCreate(metricsEntity);
    }
    //#endregion

    private async getOrganizationTimezone(
        organizationAndTeamData: any,
    ): Promise<Timezone> {
        return (
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.TIMEZONE_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;
    }

    //#region Flow Metrics
    @ValidateProjectManagementIntegration()
    public async getFlowMetricsByTeamIdAndPeriod(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: string,
        endDate: string,
        newItemsFrom: NewItemsFrom,
    ): Promise<any> {
        try {
            const team = await this.teamService.findOne({
                uuid: organizationAndTeamData.teamId,
                status: STATUS.ACTIVE,
            });

            if (!team) {
                return 'Team not found';
            }

            const timezone = await this.getOrganizationTimezone(
                organizationAndTeamData,
            );

            const bugRatioCalculator = new BugRatioCalculator();
            const throughputCalculator = new ThroughputCalculator();
            const leadTimeInWipCalculator = new LeadTimeInWipCalculator();
            const leadTimeCalculator = new LeadTimeCalculator();
            const leadTimeByColumnCalculator = new LeadTimeByColumnCalculator();
            const deliveryCapacityCalculator = new DeliveryCapacityCalculator();
            const flowEfficiencyCalculator = new FlowEfficiencyCalculator();
            const leadTimeInWipByItemTypeCalculator =
                new LeadTimeItemTypeCalculator();

            const metricsConfig = await generateFlowMetricsConfig({
                startDate,
                endDate,
            });

            const rawData =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    organizationAndTeamData,
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            const columnsConfigKey =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    organizationAndTeamData,
                );

            const waitingColumns =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.WAITING_COLUMNS,
                    organizationAndTeamData,
                );

            const enrichedColumnsConfig = columnsConfigKey.map((col) => ({
                ...col,
                columnType:
                    col.column === 'wip'
                        ? waitingColumns?.some(
                              (wc) =>
                                  wc.name.toLowerCase() ===
                                  col.name.toLowerCase(),
                          )
                            ? 'waiting'
                            : 'action'
                        : col.column,
            }));

            const result = {
                leadTime: leadTimeCalculator.formatLeadTimeForTeamAndPeriod(
                    rawData.leadTime || [],
                    timezone,
                ),
                leadTimeInWip:
                    leadTimeInWipCalculator.formatLeadTimeInWipForTeamAndPeriod(
                        rawData.leadTimeInWip || [],
                        timezone,
                    ),
                leadTimeByColumn:
                    leadTimeByColumnCalculator.processLeadTimeByColumnTeamAndPeriod(
                        rawData.leadTimeByColumn,
                        columnsConfigKey,
                        timezone,
                    ),
                throughput:
                    throughputCalculator.formatThroughputForTeamAndPeriod(
                        rawData.throughput || [],
                        timezone,
                    ),
                bugRatio: bugRatioCalculator.formatBugRatioTeamAndPeriod(
                    rawData.bugRatio || [],
                    timezone,
                ),
                deliveryCapacity:
                    deliveryCapacityCalculator.formatDeliveryCapacityForTeamAndPeriod(
                        rawData.deliveryCapacity || [],
                        newItemsFrom ? newItemsFrom : NewItemsFrom.TODO_COLUMN,
                        timezone,
                    ),
                flowEfficiency:
                    flowEfficiencyCalculator.formatFlowEfficiencyForTeamAndPeriod(
                        rawData.flowEfficiency || [],
                        timezone,
                        enrichedColumnsConfig,
                    ),
                leadTimeInWipByItemType:
                    leadTimeInWipByItemTypeCalculator.formatLeadTimeInWipByItemTypeForTeamAndPeriod(
                        rawData.leadTimeInWipByItemType || [],
                        timezone,
                    ),
            };

            return result;
        } catch (error) {
            console.error('Error processing Flow Metrics for the team:', error);
            throw error;
        }
    }

    //Get method to fetch metrics for the charts
    @ValidateProjectManagementIntegration({ allowPartialTeamConnection: true })
    public async getFlowMetricsByOrganizationIdAndPeriod(params: {
        organizationId: string;
        startDate?: string;
        endDate?: string;
    }): Promise<any> {
        let results = {
            leadTime: [],
            leadTimeInWip: [],
            throughput: [],
            bugRatio: [],
            leadTimeInWipByItemType: [],
        };
        const bugRatioCalculator = new BugRatioCalculator();
        const throughputCalculator = new ThroughputCalculator();
        const leadTimeInWipCalculator = new LeadTimeInWipCalculator();
        const leadTimeCalculator = new LeadTimeCalculator();

        const teams = await this.teamService.find(
            {
                organization: { uuid: params.organizationId },
            },
            [STATUS.ACTIVE],
        );

        if (!teams || teams?.length <= 0) {
            return;
        }

        const metricsConfig = await generateFlowMetricsConfig({
            startDate: params.startDate,
            endDate: params.endDate,
        });

        for (let team of teams) {
            const rawData: any =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    {
                        organizationId: params.organizationId,
                        teamId: team.uuid,
                    },
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            if (rawData?.leadTime && rawData.leadTime.length > 0) {
                leadTimeCalculator.processAndAppendLeadTime(
                    results.leadTime,
                    rawData.leadTime,
                    team.name,
                );
            }

            if (rawData?.leadTimeInWip && rawData.leadTimeInWip.length > 0) {
                leadTimeInWipCalculator.processAndAppendLeadTimeInWip(
                    results.leadTimeInWip,
                    rawData.leadTimeInWip,
                    team.name,
                );
            }

            if (rawData?.throughput && rawData.throughput.length > 0) {
                throughputCalculator.processAndAppendThroughput(
                    results.throughput,
                    rawData.throughput,
                    team.name,
                );
            }

            if (rawData?.bugRatio && rawData.bugRatio.length > 0) {
                bugRatioCalculator.processAndAppendBugRatio(
                    results.bugRatio,
                    rawData.bugRatio,
                    team.name,
                );
            }
        }

        return results;
    }

    @ValidateProjectManagementIntegration({ allowPartialTeamConnection: true })
    public async getLeadTimeInWipItemTypeByOrganizationIdAndPeriod(params: {
        organizationId: string;
        startDate: string;
        endDate: string;
    }): Promise<any> {
        let teamMetrics: any = [];
        const leadTimeInWipByItemTypeCalculator =
            new LeadTimeItemTypeCalculator();

        const currentDate = new Date();
        const defaultEndDate = params.endDate
            ? new Date(params.endDate)
            : new Date();
        const defaultStartDate = params.startDate
            ? new Date(params.startDate)
            : new Date(currentDate.setDate(currentDate.getDate() - 90));

        const teams = await this.teamService.find(
            {
                organization: { uuid: params.organizationId },
            },
            [STATUS.ACTIVE],
        );

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: null,
        };

        const categoryWorkItemTypesOrganizationParameter =
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.CATEGORY_WORKITEM_TYPES,
                organizationAndTeamData,
            );

        const timezone = (
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.TIMEZONE_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;

        const metricsConfig = {
            analysisPeriod: {
                startTime: defaultStartDate,
                endTime: defaultEndDate,
            },
        } as TeamMetricsConfig;

        if (!teams || teams?.length <= 0) {
            return;
        }

        for (let team of teams) {
            const rawData: any =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    {
                        organizationId: params.organizationId,
                        teamId: team.uuid,
                    },
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            if (rawData?.leadTimeInWipByItemType) {
                teamMetrics.push(...rawData?.leadTimeInWipByItemType);
            }
        }

        const results = leadTimeInWipByItemTypeCalculator.processAndAppendData(
            teamMetrics,
            categoryWorkItemTypesOrganizationParameter,
            timezone,
        );

        return results;
    }

    @ValidateProjectManagementIntegration()
    public async getLeadTimeInWipItemTypeByTeamIdAndPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        startDate: string;
        endDate: string;
    }): Promise<any> {
        try {
            const team = await this.teamService.findOne({
                uuid: params.organizationAndTeamData.teamId,
                status: STATUS.ACTIVE,
            });

            if (!team) {
                return 'Team not found';
            }

            const leadTimeInWipByItemTypeCalculator =
                new LeadTimeItemTypeCalculator();

            const currentDate = new Date();
            const defaultEndDate = params.endDate
                ? new Date(params.endDate)
                : new Date();
            const defaultStartDate = params.startDate
                ? new Date(params.startDate)
                : new Date(currentDate.setDate(currentDate.getDate() - 90));

            const metricsConfig = {
                analysisPeriod: {
                    startTime: defaultStartDate,
                    endTime: defaultEndDate,
                },
            } as TeamMetricsConfig;

            const rawData: any =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    params.organizationAndTeamData,
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            if (!rawData) {
                throw new Error(
                    'Invalid data structure returned from getRealTimeAndHistoricalMetrics',
                );
            }

            const categoryWorkItemTypesOrganizationParameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.CATEGORY_WORKITEM_TYPES,
                    params.organizationAndTeamData,
                );

            const timezone = await this.getOrganizationTimezone(
                params.organizationAndTeamData,
            );

            return leadTimeInWipByItemTypeCalculator.processAndAppendData(
                rawData.leadTimeInWipByItemType || [],
                categoryWorkItemTypesOrganizationParameter,
                timezone,
            );
        } catch (error) {
            console.error(
                'Error processing LeadTimeInWipByItemType for the team:',
                error,
            );
            throw error;
        }
    }

    @ValidateProjectManagementIntegration()
    public async compareCurrentAndLastWeekFlowMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const throughputCalculator = new ThroughputCalculator();
        const bugRatioCalculator = new BugRatioCalculator();
        const leadTimeCalculator = new LeadTimeCalculator();
        const leadTimeInWipCalculator = new LeadTimeInWipCalculator();

        const deliveryCapacityCalculator = new DeliveryCapacityCalculator();
        const flowEfficiencyCalculator = new FlowEfficiencyCalculator();

        const endDate = new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 7);

        const waitingColumns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.WAITING_COLUMNS, organizationAndTeamData);

        const metricsConfig = await generateFlowMetricsConfig({
            endDate,
            interval: MetricsAnalysisInterval.LAST_TWO_WEEKS,
            weekDay: 0,
        });

        const rawData =
            await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                metricsConfig,
            );

        const teamMetrics = [];

        teamMetrics.push(
            throughputCalculator.processThroughputForCockpit(rawData),
        );

        teamMetrics.push(bugRatioCalculator.processBugRatioForCockpit(rawData));

        teamMetrics.push(
            leadTimeCalculator.processLeadTimeDataForCockpit(rawData),
        );

        teamMetrics.push(
            leadTimeInWipCalculator.processLeadTimeDataForCockpit(rawData),
        );

        teamMetrics.push(
            deliveryCapacityCalculator.processDeliveryCapacityDataForCockpit(
                rawData,
                NewItemsFrom.TODO_COLUMN,
            ),
        );

        teamMetrics.push(
            flowEfficiencyCalculator.processFlowEfficiencyForCockpit(
                rawData,
                waitingColumns,
            ),
        );

        return teamMetrics;
    }

    private async mapLastSavedFlowMetrics(
        flowMetrics: MetricsEntity[],
    ): Promise<FlowMetricsResults> {
        const metricResults: FlowMetricsResults = {
            leadTime: null,
            leadTimeByColumn: null,
            leadTimeInWip: null,
            leadTimeInWipByItemType: null,
            leadTimeByItemType: null,
            throughput: null,
            bugRatio: null,
        };

        flowMetrics.forEach((metric) => {
            switch (metric.type) {
                case METRICS_TYPE.LEAD_TIME:
                    metricResults.leadTime = metric.value;
                    break;
                case METRICS_TYPE.LEAD_TIME_BY_COLUMN:
                    metricResults.leadTimeByColumn = metric.value;
                    break;
                case METRICS_TYPE.LEAD_TIME_IN_WIP:
                    metricResults.leadTimeInWip = metric.value;
                    break;
                case METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE:
                    metricResults.leadTimeInWipByItemType = metric.value;
                    break;
                case METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE:
                    metricResults.leadTimeByItemType = metric.value;
                    break;
                case METRICS_TYPE.THROUGHPUT:
                    metricResults.throughput = metric.value.value;
                    break;
                case METRICS_TYPE.BUG_RATIO:
                    metricResults.bugRatio = metric.value;
                    break;
            }
        });

        return metricResults;
    }
    //#endregion

    //#region Dora Metrics
    @ValidateCodeManagementIntegration()
    public async getDoraMetricsByTeamIdAndPeriod(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: string,
        endDate: string,
    ): Promise<any> {
        try {
            const team = await this.teamService.findOne({
                uuid: organizationAndTeamData.teamId,
                status: STATUS.ACTIVE,
            });

            if (!team) {
                return 'Team not found';
            }

            const deployFrequencyCalculator = new DeployFrequencyCalculator();
            const leadTimeForChangeCalculator =
                new LeadTimeForChangeCalculator();

            const metricsConfig = await generateDoraMetricsConfig({
                startDate,
                endDate,
            });

            const rawData =
                await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                    organizationAndTeamData,
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            const timezone = await this.getOrganizationTimezone(
                organizationAndTeamData,
            );

            return {
                deployFrequency:
                    deployFrequencyCalculator.formatDeployFrequencyTeamAndPeriod(
                        rawData.deployFrequency,
                        timezone,
                    ),
                leadTimeForChange:
                    leadTimeForChangeCalculator.formatLeadTimeForChangesTeamAndPeriod(
                        rawData.leadTimeForChange,
                        timezone,
                    ),
            };
        } catch (error) {
            console.error('Error processing Dora Metrics for the team:', error);
            throw error;
        }
    }

    @ValidateCodeManagementIntegration({
        allowPartialTeamConnection: true,
        onlyCheckConnection: true,
    })
    public async getDoraMetricsByOrganizationIdAndPeriod(
        params: {
            organizationId: string;
            startDate?: string;
            endDate?: string;
        },
        integrationStatus?: CodeManagementConnectionStatus,
    ): Promise<any> {
        let results = {
            deployFrequency: [],
            leadTimeForChange: [],
            teamsCodeManagementConfig: [],
        };

        if (integrationStatus && !integrationStatus.hasConnection) {
            return results;
        }

        const leadTimeForChangeCalculator = new LeadTimeForChangeCalculator();

        const teams = await this.teamService.findTeamsWithIntegrations({
            organizationId: params.organizationId,
            status: STATUS.ACTIVE,
            integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
            integrationStatus: IntegrationStatusFilter.CONFIGURED,
        });

        if (!teams || teams?.length <= 0) {
            return results;
        }

        const metricsConfig = await generateDoraMetricsConfig({
            startDate: params?.startDate,
            endDate: params?.endDate,
        });

        const deployFrequencyCalculator = new DeployFrequencyCalculator();
        deployFrequencyCalculator.setConfiguration({
            analysisPeriod: metricsConfig.analysisPeriod,
        });

        for (let team of teams) {
            const rawData: any =
                await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                    {
                        organizationId: params.organizationId,
                        teamId: team.uuid,
                    },
                    MetricsConversionStructure.METRICS_TREND,
                    metricsConfig,
                );

            leadTimeForChangeCalculator.processAndAppendLeadTimeForChanges(
                results.leadTimeForChange,
                rawData.leadTimeForChange,
                team.name,
            );

            results.deployFrequency.push(...rawData.deployFrequency);

            results.teamsCodeManagementConfig.push({
                teamName: team.name,
                teamId: team.uuid,
                missingConnection: 'codeManagement',
            });
        }

        const deployFrequency =
            deployFrequencyCalculator.calculateAverageOrganizationDeployFrequency(
                results.deployFrequency,
            );

        return {
            deployFrequency,
            leadTimeForChange: results.leadTimeForChange,
        };
    }

    @ValidateCodeManagementIntegration()
    public async compareCurrentAndLastWeekDoraMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const teamMetrics = [];

        const endDate = new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 14);

        const rawData =
            await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                {
                    analysisPeriod: {
                        startTime: startDate,
                        endTime: endDate,
                    },
                    daysInterval: 7,
                    weekDay: 0,
                },
            );

        const deployFrequencyCalculator = new DeployFrequencyCalculator();
        const leadTimeForChangeCalculator = new LeadTimeForChangeCalculator();

        teamMetrics.push(
            deployFrequencyCalculator.processDeployFrequencyForCockpit(rawData),
            leadTimeForChangeCalculator.processLeadTimeForChangesForCockpit(
                rawData,
            ),
        );

        return teamMetrics;
    }

    private async mapLastSavedDoraMetrics(
        doraMetrics: MetricsEntity[],
    ): Promise<DoraMetricsResults> {
        const doraMetricResults: DoraMetricsResults = {
            leadTimeForChange: null,
            deployFrequency: null,
        };

        doraMetrics.forEach((metric) => {
            switch (metric.type) {
                case METRICS_TYPE.LEAD_TIME_FOR_CHANGE:
                    doraMetricResults.leadTimeForChange = metric.value;
                    break;
                case METRICS_TYPE.DEPLOY_FREQUENCY:
                    doraMetricResults.deployFrequency = metric.value;
                    break;
            }
        });

        return doraMetricResults;
    }
    //#endregion

    //Called only in the Organization Metrics Service
    public async getTeamMetricsByPeriod(
        teamId: string,
        howManyDays: number = 7,
        currentDate?: Date,
    ): Promise<IMetrics[]> {
        const endDate = currentDate ? new Date(currentDate) : new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - howManyDays);

        const filter: Partial<IMetrics> = {
            team: { uuid: teamId },
        };

        const metrics = await this.metricsRepository.find(filter);

        // Manual filtering of metrics by date
        const filteredMetrics = metrics?.filter((metric) => {
            const metricDate = new Date(metric.referenceDate);
            return metricDate >= startDate && metricDate <= endDate;
        });

        // Manual sorting
        filteredMetrics?.sort(
            (a, b) =>
                new Date(b.referenceDate).getTime() -
                new Date(a.referenceDate).getTime(),
        );

        const groupedMetrics = this.groupMetricsByType(filteredMetrics);
        const mappedMetrics: IMetrics[] = [];

        if (!groupedMetrics) {
            return mappedMetrics;
        }

        for (const [type, typeMetrics] of Object.entries(groupedMetrics)) {
            const latestMetric = typeMetrics[0];
            let mappedValue;

            switch (type as METRICS_TYPE) {
                case METRICS_TYPE.LEAD_TIME:
                case METRICS_TYPE.LEAD_TIME_BY_COLUMN:
                case METRICS_TYPE.LEAD_TIME_IN_WIP:
                case METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE:
                case METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE:
                case METRICS_TYPE.LEAD_TIME_FOR_CHANGE:
                case METRICS_TYPE.DEPLOY_FREQUENCY:
                case METRICS_TYPE.BUG_RATIO:
                    mappedValue = latestMetric.value;
                    break;
                case METRICS_TYPE.THROUGHPUT:
                    mappedValue = latestMetric.value.value;
                    break;
                default:
                    mappedValue = latestMetric.value;
            }

            mappedMetrics.push({
                uuid: latestMetric.uuid,
                type: latestMetric.type as METRICS_TYPE,
                value: mappedValue,
                status: latestMetric.status,
                team: { uuid: teamId },
                createdAt: latestMetric.referenceDate,
                category: latestMetric.category as METRICS_CATEGORY,
                referenceDate: latestMetric.referenceDate,
            });
        }

        return mappedMetrics;
    }

    //Called only through the Factory classes (Flow and Dora)
    public MapToMetricsTrend(
        metrics: MetricsEntity[],
    ): Record<string, MetricTrend[]> {
        const metricTrendAnalyzerAndFormatter =
            new MetricTrendAnalyzerAndFormatter();
        const groupedMetrics: Record<string, MetricsEntity[]> = {};

        metrics.forEach((metric) => {
            if (!groupedMetrics[metric.type]) {
                groupedMetrics[metric.type] = [];
            }
            groupedMetrics[metric.type].push(metric);
        });

        const result: Record<string, MetricTrend[]> = {};
        for (const [type, typeMetrics] of Object.entries(groupedMetrics)) {
            result[type] =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    type,
                    typeMetrics,
                );
        }

        return result;
    }

    //Called only through the Factory classes (Flow and Dora)
    public MapToIMetrics(metrics: MetricsEntity[], teamId: string): IMetrics[] {
        if (!Array.isArray(metrics)) {
            console.error('Invalid input for MapToIMetrics:', metrics);
            return [];
        }

        return metrics.map((metric) => ({
            uuid: metric.uuid,
            type: metric.type as METRICS_TYPE,
            value: metric.value,
            status: metric.status,
            team: { uuid: teamId },
            createdAt: metric.referenceDate,
            category: metric.category as METRICS_CATEGORY,
            referenceDate: metric.referenceDate,
        }));
    }

    private async findLastSavedMetricsByTeamId(
        teamId: string,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ) {
        return this.metricsRepository.findTeamMetricsHistoryWithConfigurableParams(
            teamId,
            metricsConfig,
        );
    }

    private groupMetricsByType(
        metrics: MetricsEntity[],
    ): Record<string, MetricsEntity[]> {
        return metrics?.reduce(
            (acc, metric) => {
                if (!acc[metric.type]) {
                    acc[metric.type] = [];
                }
                acc[metric.type].push(metric);
                return acc;
            },
            {} as Record<string, MetricsEntity[]>,
        );
    }
}
