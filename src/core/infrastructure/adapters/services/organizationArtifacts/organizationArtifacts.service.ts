import { IOrganizationArtifactsService } from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import * as moment from 'moment-timezone';
import { PinoLoggerService } from '../logger/pino.service';
import {
    IOrganizationArtifactsRepository,
    ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN,
} from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.repository';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationArtifacts } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifacts.interface';
import { TeamDeliveryAtRiskArtifact } from './artifacts/teamDeliveryAtRisk.artifact';
import { OrganizationAnalysisType } from '@/core/domain/organizationArtifacts/enums/organizationAnalysIsType.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { organizationArtifacts } from './organizationArtifactsStructure.json';
import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItemType.type';
import { ModuleWorkItemType } from '@/core/domain/integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import {
    FlowMetricsConfig,
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { getPreviousWeekRange } from '@/shared/utils/helpers';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { FlowQualityDeclineArtifact } from './artifacts/flowQualityDecline.artifact';
import { SpeedDropAlertArtifact } from './artifacts/speedDropAlert.artifact';
import { QualityDropSignalArtifact } from './artifacts/qualityDropSignal.artifact';
import { DuplicateEffortWarningArtifact } from './artifacts/duplicateEffortWarning.artifact';
import { ThroughputVariabilityAlertArtifact } from './artifacts/throughputVariabilityAlert.artifact';
import {
    MetricTrend,
    MetricTrendAnalyzerAndFormatter,
} from '../metrics/processMetrics/metricAnalyzerAndFormatter';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { OrganizationArtifactsEntity } from '@/core/domain/organizationArtifacts/entities/organizationArtifacts.entity';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { PromptService } from '../prompt.service';
import { STATUS } from '@/config/types/database/status.type';
import { HighWorkloadPerTeamArtifact } from './artifacts/highWorkloadPerTeam.artifact';
import { TeamMethodology } from '@/shared/domain/enums/team-methodology.enum';
import { MetricsConversionStructure } from '@/shared/domain/interfaces/metrics';
import { generateFlowMetricsConfig } from '@/shared/utils/metrics/generateFlowMetricsConfig.utils';
import { MetricsAnalysisInterval } from '@/shared/utils/metrics/metricsAnalysisInterval.enum';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';

@Injectable()
export class OrganizationArtifactsService
    implements IOrganizationArtifactsService
{
    private teamDeliveryAtRiskArtifact: TeamDeliveryAtRiskArtifact;
    private flowQualityDeclineArtifact: FlowQualityDeclineArtifact;
    private speedDropAlertArtifact: SpeedDropAlertArtifact;
    private qualityDropSignalArtifact: QualityDropSignalArtifact;
    private duplicateEffortWarningArtifact: DuplicateEffortWarningArtifact;
    private throughputVariabilityAlertArtifact: ThroughputVariabilityAlertArtifact;
    private highWorkloadPerTeamArtifact: HighWorkloadPerTeamArtifact;

    constructor(
        @Inject(ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN)
        private readonly organizationArtifactsRepository: IOrganizationArtifactsRepository,

        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamsService: ITeamService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        private readonly projectManagementService: ProjectManagementService,
        private readonly promptService: PromptService,
        private logger: PinoLoggerService,
    ) {
        this.initArtifacts();
    }

    dismissArtifact(
        artifactId: string,
        userId: string,
        organizationTeamAndData: OrganizationAndTeamData,
    ): Promise<void> {
        return this.organizationArtifactsRepository.dismissArtifact(
            artifactId,
            userId,
            organizationTeamAndData,
        );
    }

    @ValidateProjectManagementIntegration({
        allowPartialTeamConnection: true,
    })
    async executeWeekly(
        organizationAndTeamData: OrganizationAndTeamData,
        artifactsToolType?: ArtifactsToolType,
    ) {
        try {
            const teams = await this.teamsService.findTeamsWithIntegrations({
                organizationId: organizationAndTeamData.organizationId,
                status: STATUS.ACTIVE,
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                integrationCategories: [IntegrationCategory.PROJECT_MANAGEMENT],
                // Currently, there are only project-level artifacts at the organization level
            });

            if (!teams || teams?.length === 0) {
                return;
            }

            const dataLoadedByTeam: IOrganizationArtifacExecutiontPayload[] =
                [];

            const flowMetricsConfig = await generateFlowMetricsConfig({
                interval: MetricsAnalysisInterval.LAST_MONTH,
            });

            for (const team of teams) {
                const newOrganizationAndTeamData = {
                    ...organizationAndTeamData,
                    teamId: team.uuid,
                };

                const artifacts =
                    await this.teamArtifactsService.getRecentTeamArtifactsWithPrevious(
                        newOrganizationAndTeamData,
                        4,
                    );

                const organizationTeamArtifactsFromParameters = (
                    await this.parametersService.findByKey(
                        ParametersKey.ORGANIZATION_ARTIFACTS_CONFIG,
                        newOrganizationAndTeamData,
                    )
                )?.configValue;

                const teamMethodology =
                    await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                        IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                        newOrganizationAndTeamData,
                    );

                const result = await this.processData(
                    newOrganizationAndTeamData,
                    teamMethodology,
                    OrganizationAnalysisType.WEEKLY,
                    flowMetricsConfig,
                );

                if (!result) {
                    return;
                }

                const {
                    workItemsDefault,
                    metrics,
                    columns,
                    wipColumns,
                    waitingColumns,
                    bugTypeIdentifiers,
                    workItemTypes,
                    period,
                    workItemsWithDeliveryStatus,
                    throughputMetricsHistoric,
                    bugsInWip,
                    workItemsCreatedInCurrentWeek,
                } = result;

                dataLoadedByTeam.push({
                    teamName: team.name,
                    organizationAndTeamData: newOrganizationAndTeamData,
                    bugTypeIdentifiers,
                    workItemTypes,
                    frequenceType: 'weekly',
                    teamMethodology,
                    workItems: workItemsDefault,
                    columns,
                    wipColumns,
                    period,
                    waitingColumns,
                    metrics,
                    workItemsWithDeliveryStatus,
                    teamArtifacts: artifacts,
                    throughputMetricsHistoric,
                    bugsInWip,
                    organizationTeamArtifactsFromParameters,
                    workItemsCreatedInCurrentWeek,
                });
            }

            for (const artifact of await this.filterArtifactsToUse('weekly')) {
                if (dataLoadedByTeam && dataLoadedByTeam.length > 0) {
                    const artifactResult = this.artifactSelector(
                        artifact.name,
                    )?.execute(artifact, dataLoadedByTeam);

                    if (!artifactResult) {
                        continue;
                    }

                    this.organizationArtifactsRepository.create(artifactResult);
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing OrganizationArtifacts Weekly',
                context: OrganizationArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    @ValidateProjectManagementIntegration({ allowPartialTeamConnection: true })
    async executeDaily(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const teams = await this.teamsService.findTeamsWithIntegrations({
                organizationId: organizationAndTeamData.organizationId,
                status: STATUS.ACTIVE,
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                integrationCategories: [IntegrationCategory.PROJECT_MANAGEMENT],
                // Currently, there are only project-level artifacts at the organization level
            });

            if (!teams || teams?.length === 0) {
                return;
            }

            const dataLoadedByTeam: IOrganizationArtifacExecutiontPayload[] =
                [];

            const flowMetricsConfig = await generateFlowMetricsConfig({
                interval: MetricsAnalysisInterval.LAST_WEEK,
            });

            for (const team of teams) {
                const newOrganizationAndTeamData = {
                    ...organizationAndTeamData,
                    teamId: team.uuid,
                };

                const teamMethodology =
                    await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                        IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                        newOrganizationAndTeamData,
                    );

                const organizationTeamArtifactsFromParameters = (
                    await this.parametersService.findByKey(
                        ParametersKey.ORGANIZATION_ARTIFACTS_CONFIG,
                        newOrganizationAndTeamData,
                    )
                )?.configValue;

                const result = await this.processData(
                    newOrganizationAndTeamData,
                    teamMethodology,
                    OrganizationAnalysisType.DAILY,
                    flowMetricsConfig,
                );

                if (!result) {
                    return;
                }

                const {
                    workItemsDefault,
                    bugTypeIdentifiers,
                    workItemTypes,
                    workItemsWithDeliveryStatus,
                    wipColumns,
                    period,
                } = result;

                dataLoadedByTeam.push({
                    teamName: team.name,
                    organizationAndTeamData: newOrganizationAndTeamData,
                    bugTypeIdentifiers,
                    workItemTypes,
                    frequenceType: 'daily',
                    teamMethodology,
                    workItems: workItemsDefault,
                    workItemsWithDeliveryStatus,
                    wipColumns,
                    period,
                    organizationTeamArtifactsFromParameters,
                });
            }

            for (const artifact of await this.filterArtifactsToUse('daily')) {
                if (dataLoadedByTeam && dataLoadedByTeam.length > 0) {
                    const artifactExecution = this.artifactSelector(
                        artifact.name,
                    );
                    let artifactResult = null;

                    if (
                        artifactExecution &&
                        artifact.name === 'DuplicateEffortWarning'
                    ) {
                        artifactResult = await artifactExecution?.execute(
                            artifact,
                            dataLoadedByTeam,
                            this.runDuplicateEffortWarningLLM.bind(this),
                        );
                    } else {
                        artifactResult = artifactExecution?.execute(
                            artifact,
                            dataLoadedByTeam,
                        );
                    }

                    if (!artifactResult) {
                        continue;
                    }

                    this.organizationArtifactsRepository.create(artifactResult);
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing OrganizationArtifacts Daily',
                context: OrganizationArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    async getVisibleArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        userId?: string,
    ): Promise<any[]> {
        try {
            const organizationArtifacts =
                await this.organizationArtifactsRepository.getVisibleArtifacts(
                    organizationAndTeamData,
                    userId,
                );

            if (!organizationArtifacts) {
                return [];
            }

            const artifacts = [];

            for (const organizationArtifact of organizationArtifacts) {
                for (const teamArtifact of organizationArtifact.teamsArtifact) {
                    artifacts.push({
                        id: organizationArtifact.uuid,
                        name: organizationArtifact.name,
                        title: teamArtifact.title,
                        description: organizationArtifact.description,
                        whyIsImportant: organizationArtifact.whyIsImportant,
                        negativeImpact: teamArtifact.description,
                        criticality: teamArtifact.criticality,
                        teamName: teamArtifact.teamName,
                        teamId: teamArtifact.teamId,
                        organizationId: organizationArtifact.organizationId,
                        additionalInfoFormated:
                            teamArtifact.additionalInfoFormated,
                        impactArea: organizationArtifact.impactArea,
                        category: organizationArtifact.category,
                        analysisFinalDate: moment(
                            organizationArtifact.analysisFinalDate,
                        ).format('DD/MM/YYYY'),
                    });
                }
            }

            return artifacts;
        } catch (error) {
            console.error(error);
        }
    }

    create(
        organizationArtifacts: Omit<IOrganizationArtifacts, 'uuid'>,
    ): Promise<OrganizationArtifactsEntity> {
        return this.organizationArtifactsRepository.create(
            organizationArtifacts,
        );
    }

    update(
        filter: Partial<IOrganizationArtifacts>,
        data: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity> {
        return this.organizationArtifactsRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.organizationArtifactsRepository.delete(uuid);
    }

    find(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity[]> {
        return this.organizationArtifactsRepository.find(filter);
    }

    getNativeCollection() {
        return this.organizationArtifactsRepository.getNativeCollection();
    }

    findOne(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity> {
        return this.organizationArtifactsRepository.findOne(filter);
    }

    getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
    ): Promise<OrganizationArtifactsEntity[]> {
        return this.organizationArtifactsRepository.getMostRecentArtifacts(
            organizationAndTeamData,
            frequenceType,
        );
    }

    getOrganizationArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType: string = 'weekly',
    ): Promise<OrganizationArtifactsEntity[]> {
        return this.organizationArtifactsRepository.getOrganizationArtifactsByWeeksLimit(
            organizationAndTeamData,
            weeksLimit,
            frequenceType,
        );
    }

    async getRecentOrganizationArtifactsWithPrevious(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
    ): Promise<{
        mostRecentArtifacts: {
            date: string;
            artifacts: Partial<OrganizationArtifactsEntity>[];
        };
        previousArtifacts: {
            date: string;
            artifacts: Partial<OrganizationArtifactsEntity>[];
        }[];
    }> {
        try {
            // Fetch artifacts using the repository
            const artifacts: OrganizationArtifactsEntity[] =
                await this.organizationArtifactsRepository.getOrganizationArtifactsByWeeksLimit(
                    organizationAndTeamData,
                    weeksLimit,
                    frequenceType,
                );

            if (!artifacts?.length) {
                return {
                    mostRecentArtifacts: {
                        date: '',
                        artifacts: [],
                    },
                    previousArtifacts: [],
                };
            }

            // Process artifacts to organize them according to the desired structure
            const groupedByDate: {
                [date: string]: OrganizationArtifactsEntity[];
            } = artifacts.reduce((acc, artifact) => {
                const date = moment(artifact.analysisFinalDate).format(
                    'YYYY-MM-DD',
                );
                if (!acc[date]) {
                    acc[date] = [];
                }
                acc[date].push(artifact);
                return acc;
            }, {});

            const sortedDates = Object.keys(groupedByDate).sort(
                (a, b) => new Date(b).getTime() - new Date(a).getTime(),
            );

            // Assume the most recent date is the first after sorting
            const mostRecentDate = sortedDates[0];
            const mostRecentArtifacts = {
                date: mostRecentDate,
                artifacts: groupedByDate[mostRecentDate].map((artifact) => {
                    return {
                        name: artifact.name,
                        description: artifact.description,
                        category: artifact.category,
                        resultType: artifact.resultType,
                        howIsIdentified: artifact.howIsIdentified,
                        whyIsImportant: artifact.whyIsImportant,
                        impactArea: artifact.impactArea,
                        analysisFinalDate: artifact.analysisFinalDate,
                        frequenceType: artifact.frequenceType,
                    };
                }),
            };

            // All other artifacts are considered previous
            const previousArtifacts = sortedDates.slice(1).map((date) => ({
                date: date,
                artifacts: groupedByDate[date].map((artifact) => {
                    return {
                        name: artifact.name,
                        description: artifact.description,
                        category: artifact.category,
                        resultType: artifact.resultType,
                        howIsIdentified: artifact.howIsIdentified,
                        whyIsImportant: artifact.whyIsImportant,
                        impactArea: artifact.impactArea,
                        analysisFinalDate: artifact.analysisFinalDate,
                        frequenceType: artifact.frequenceType,
                    };
                }),
            }));

            // Return the structured object with MostRecentArtifacts and PreviousArtifacts
            return {
                mostRecentArtifacts,
                previousArtifacts,
            };
        } catch (error) {
            console.error(error);
        }
    }

    private initArtifacts() {
        this.teamDeliveryAtRiskArtifact = new TeamDeliveryAtRiskArtifact();
        this.flowQualityDeclineArtifact = new FlowQualityDeclineArtifact();
        this.speedDropAlertArtifact = new SpeedDropAlertArtifact();
        this.qualityDropSignalArtifact = new QualityDropSignalArtifact();
        this.duplicateEffortWarningArtifact =
            new DuplicateEffortWarningArtifact();
        this.throughputVariabilityAlertArtifact =
            new ThroughputVariabilityAlertArtifact();
        this.highWorkloadPerTeamArtifact = new HighWorkloadPerTeamArtifact();
    }

    private artifactSelector(name: string) {
        const result = {
            TeamDeliveryAtRisk: this.teamDeliveryAtRiskArtifact,
            FlowQualityDecline: this.flowQualityDeclineArtifact,
            SpeedDropAlert: this.speedDropAlertArtifact,
            QualityDropSignal: this.qualityDropSignalArtifact,
            DuplicateEffortWarning: this.duplicateEffortWarningArtifact,
            ThroughputVariabilityAlert: this.throughputVariabilityAlertArtifact,
            HighWorkloadPerTeam: this.highWorkloadPerTeamArtifact,
        };

        return result[name];
    }

    private async filterArtifactsToUse(frequenceType: string) {
        return organizationArtifacts.filter(
            (artifact) =>
                artifact.status &&
                artifact.frequenceTypes?.includes(frequenceType),
        );
    }

    private async runDuplicateEffortWarningLLM(
        duplicateWorkItems: {
            workItems: Item[];
            teamId: string;
            teamName: string;
        }[],
        organizationId: string,
    ) {
        try {
            const teamsId: string[] = [];
            const llm = getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_TURBO,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            const workItemsMerged: any[] = [];
            duplicateWorkItems.forEach((data) => {
                teamsId.push(data.teamId);
                const workItemFormatted = data?.workItems
                    ?.filter(
                        (filterWorkItem: Item) => filterWorkItem?.description,
                    )
                    ?.map((workItem: Item) => ({
                        id: workItem.id,
                        key: workItem.key,
                        name: workItem.name,
                        description: workItem?.description,
                        teamName: data.teamName,
                    }));

                workItemsMerged.push(workItemFormatted);
            });

            const workItemsFormatted = workItemsMerged.flatMap((item) => item);

            const promptRewriteArtifacts =
                await this.promptService.getCompleteContextPromptByName(
                    'prompt_duplicateEffortWarning',
                    {
                        organizationAndTeamData: {
                            organizationId: organizationId,
                        },
                        payload: JSON.stringify(workItemsFormatted),
                        promptIsForChat: false,
                    },
                );

            const artifactsForCheckin = await llm.invoke(
                promptRewriteArtifacts,
                {
                    metadata: {
                        module: 'AutomationSprintRetro',
                        teamsId: teamsId,
                        submodule: 'RewriteArtifacts',
                    },
                },
            );

            return artifactsForCheckin;
        } catch (error) {
            console.log(error);
        }
    }

    private async processData(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMethodology: string,
        organizationAnalysisType: OrganizationAnalysisType,
        flowMetricsConfig?: FlowMetricsConfig,
    ) {
        let period = getPreviousWeekRange();

        const columns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.COLUMNS_MAPPING, organizationAndTeamData);

        const waitingColumns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.WAITING_COLUMNS, organizationAndTeamData);

        const wipColumns = columns
            ?.filter(
                (columnConfig: ColumnsConfigKey) =>
                    columnConfig.column === 'wip',
            )
            .map((columnConfig) => {
                return { id: columnConfig.id, name: columnConfig.name };
            });

        const doneColumn = columns
            ?.filter(
                (columnConfig: ColumnsConfigKey) =>
                    columnConfig.column === 'done',
            )
            .map((columnConfig) => {
                return { id: columnConfig.id, name: columnConfig.name };
            });

        const columnsConfig: ColumnsConfigResult = {
            allColumns: columns,
            todoColumns: wipColumns?.map((todoColumn) => todoColumn.id),
            wipColumns: wipColumns?.map((wipColumn) => wipColumn.id),
            doneColumns: doneColumn?.map((doneColumn) => doneColumn.id),
        };

        const bugTypeIdentifiers =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Partial<WorkItemType>[]
            >(
                IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
                organizationAndTeamData,
            );

        const metricTrendAnalyzerAndFormatter =
            new MetricTrendAnalyzerAndFormatter();

        const metricsHistoric =
            await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                flowMetricsConfig,
            );

        const throughputMetricsHistoric: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.THROUGHPUT,
                metricsHistoric,
            );

        const {
            workItemsDefault,
            metrics,
            workItemTypes,
            workItemsWithDeliveryStatus,
            bugsInWip,
            workItemsCreatedInCurrentWeek,
        } = await this.processWeeklyOrSprintDataToExecution(
            organizationAndTeamData,
            period,
            columnsConfig,
            organizationAnalysisType,
            teamMethodology,
            bugTypeIdentifiers,
            flowMetricsConfig,
        );

        return {
            workItemsDefault,
            metrics,
            columns,
            wipColumns,
            waitingColumns,
            bugTypeIdentifiers,
            workItemTypes,
            period,
            workItemsWithDeliveryStatus,
            throughputMetricsHistoric,
            bugsInWip,
            workItemsCreatedInCurrentWeek,
        };
    }

    private async processWeeklyOrSprintDataToExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        period: { startDate: string; endDate: string },
        columnsConfig: ColumnsConfigResult,
        organizationAnalysisType: OrganizationAnalysisType,
        teamMethodology?: string,
        bugTypeIdentifiers?: any[],
        flowMetricsConfig?: FlowMetricsConfig,
    ) {
        let workItems: Item[] = [];

        const metrics =
            await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.I_METRICS,
                flowMetricsConfig,
            );

        if (!metrics) {
            this.logger.warn({
                message:
                    'No metrics found for the team (Maybe the team has no integration or there is an issue)',
                context: OrganizationArtifactsService.name,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return;
        }

        const statusesIds = columnsConfig?.wipColumns
            ?.map((wipColumn) => wipColumn)
            .concat(
                columnsConfig?.doneColumns?.map((doneColumn) => doneColumn),
            );

        const allStatusesIds = columnsConfig?.allColumns?.map((x) => x.id);

        workItems = await this.getWorkItemsInWIPOrDone(
            organizationAnalysisType,
            organizationAndTeamData,
            statusesIds,
            period,
            teamMethodology,
        );

        const workItemsCreatedInCurrentWeek =
            await this.projectManagementService.getWorkItemsByCreatedDateAndStatus(
                {
                    organizationAndTeamData: organizationAndTeamData,
                    createdAt: period.startDate,
                    statusIds: allStatusesIds,
                    columnsConfig: columnsConfig,
                },
            );

        const { workItemTypesDefault, workItemTypes } =
            await this.getWorkItemsTypes(organizationAndTeamData);

        const wipWorkItems =
            await this.projectManagementService.getAllWorkItemsInWIP({
                organizationAndTeamData,
                filters: {
                    statusesIds: columnsConfig.wipColumns,
                    getDescription: false,
                    workItemTypes: workItemTypesDefault,
                    movementFilter: null,
                    expandChangelog: true,
                    showDescription: true,
                },
            });

        const workItemsWithDeliveryStatus =
            await this.metricsFactory.getWorkItemsDeliveryStatus(
                organizationAndTeamData,
                wipWorkItems,
                metrics,
                columnsConfig,
                teamMethodology,
            );

        const workItemsDefault = workItems.filter((issue) => {
            return workItemTypesDefault.some((workItemType) => {
                return (
                    workItemType.id === issue.workItemType.id ||
                    workItemType.name === issue.workItemType.name
                );
            });
        });

        const bugsInWip = await this.getBugsInWip({
            organizationAndTeamData,
            bugTypeIdentifiers,
            filters: {
                movementFilter: null,
                expandChangelog: true,
                showDescription: true,
            },
        });

        return {
            workItemsDefault,
            metrics,
            workItemTypes,
            workItemsWithDeliveryStatus,
            bugsInWip,
            workItemsCreatedInCurrentWeek,
        };
    }

    private async getWorkItemsInWIPOrDone(
        organizationAnalysIsType: OrganizationAnalysisType,
        organizationAndTeamData: OrganizationAndTeamData,
        statusesIds,
        period,
        teamMethodology,
    ): Promise<Item[]> {
        const workItemTypesDefault =
            await this.projectManagementService.getWorkItemsTypes(
                organizationAndTeamData,
                MODULE_WORKITEMS_TYPES.DEFAULT,
            );

        if (
            organizationAnalysIsType === OrganizationAnalysisType.SPRINT ||
            teamMethodology?.toLowerCase() === TeamMethodology.SCRUM
        ) {
            return await this.projectManagementService.getWorkItemsByCurrentSprint(
                {
                    organizationAndTeamData: organizationAndTeamData,
                    filters: {
                        statusesIds,
                        period,
                        workItemTypes: workItemTypesDefault,
                        movementFilter: (item) => item.field !== 'description',
                        expandChangelog: true,
                        showDescription: true,
                    },
                },
            );
        }

        return await this.projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
            {
                organizationAndTeamData,
                filters: {
                    statusesIds,
                    period,
                    workItemTypes: workItemTypesDefault,
                    movementFilter: (item) => item.field !== 'description',
                    expandChangelog: true,
                    showDescription: true,
                },
            },
        );
    }

    private async getWorkItemsTypes(payload) {
        const workItemTypes =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ModuleWorkItemType[]
            >(IntegrationConfigKey.MODULE_WORKITEMS_TYPES, {
                organizationId: payload.organizationId,
                teamId: payload.teamId,
            });

        const workItemTypesDefault = workItemTypes.find(
            (workItemType) =>
                workItemType.name === MODULE_WORKITEMS_TYPES.DEFAULT,
        ).workItemTypes;

        const workItemTypesImproveTaskDescription = workItemTypes.find(
            (workItemType) =>
                workItemType.name ===
                MODULE_WORKITEMS_TYPES.IMPROVE_TASK_DESCRIPTION,
        ).workItemTypes;

        return {
            workItemTypesDefault,
            workItemTypesImproveTaskDescription,
            workItemTypes,
        };
    }

    private async getBugsInWip(params) {
        return await this.projectManagementService.getBugsInWip(params);
    }
}
