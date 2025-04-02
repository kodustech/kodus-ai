import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { TeamArtifactsEntity } from '@/core/domain/teamArtifacts/entities/teamArtifacts.entity';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { BugRatioMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/bugRatio';
import { LeadTimeInWipMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/leadTimeInWip';
import { ThroughputMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/throughput';
import { LeadTimeByColumnMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/leadTimeByColumn';
import { LeadTimeForChangeMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/doraMetrics/leadTimeForChange';
import { DeployFrequencyMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/doraMetrics/deployFrequency';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { ITeamArtifactToEnrichData } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { artifacts as artifactsStructure } from '@/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json';
import * as moment from 'moment-timezone';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { MetricsConversionStructure } from '@/shared/domain/interfaces/metrics';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class EnrichTeamArtifactsUseCase {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private teamArtifactsService: ITeamArtifactsService,

        @Inject(METRICS_FACTORY_TOKEN)
        private metricsFactory: IMetricsFactory,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private doraMetricsFactory: IDoraMetricsFactory,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private projectManagementService: ProjectManagementService,

        private logger: PinoLoggerService,

        private readonly promptService: PromptService,
    ) {}

    async execute(
        organizationTeamAndData: OrganizationAndTeamData,
        isProjectManagementConfigured: boolean,
        isCodeManagementConfigured: boolean,
    ): Promise<ITeamArtifactToEnrichData[]> {
        try {
            const teamProjectSettings = isProjectManagementConfigured
                ? await this.getTeamProjectSettings(organizationTeamAndData)
                : null;

            const teamContextData = await this.getTeamContextData(
                organizationTeamAndData,
                isCodeManagementConfigured,
                isProjectManagementConfigured,
            );

            const metricsMapped = await this.mapTeamMetrics(
                teamContextData.flowMetrics,
                teamContextData.doraMetrics,
            );

            if (
                !teamContextData?.artifacts ||
                teamContextData?.artifacts?.length === 0
            ) {
                return [];
            }

            const artifactsMapped = await this.mapTeamArtifacts(
                teamContextData.artifacts,
            );

            const currentArtifacts =
                await this.teamArtifactsService.getMostRecentArtifacts(
                    organizationTeamAndData,
                    'weekly',
                    'Negative',
                );

            const filtredCurrentArtifacts =
                await this.mapTeamArtifacts(currentArtifacts);

            const impactDataRelationships =
                await this.mapImpactorArtifactsAndMetrics(
                    filtredCurrentArtifacts,
                );

            const enrichedCurrentArtifacts = await this.dataEnrichmentProcess(
                organizationTeamAndData,
                teamProjectSettings,
                metricsMapped,
                artifactsMapped,
                filtredCurrentArtifacts,
                impactDataRelationships,
            );

            const bulkUpdateRelatedData = await this.prepareBulkUpdateData(
                enrichedCurrentArtifacts.currentArtifactsWithSumarization,
            );

            await this.teamArtifactsService.bulkUpdateOfEnrichedArtifacts(
                organizationTeamAndData,
                bulkUpdateRelatedData,
            );

            return;
        } catch (error) {
            this.logger.error({
                message: 'Error while trying to enrich team artifacts',
                context: EnrichTeamArtifactsUseCase.name,
                serviceName: 'EnrichTeamArtifactsUseCase',
                error: error,
                metadata: {
                    teamId: organizationTeamAndData.teamId,
                    organizationId: organizationTeamAndData.organizationId,
                },
            });
        }
    }

    private async dataEnrichmentProcess(
        organizationTeamAndData,
        teamProjectSettings,
        metricsMapped,
        artifactsMapped,
        currentArtifacts,
        impactDataRelationships,
    ) {
        const currentArtifactsWithoutImpactDataRelationship =
            currentArtifacts.map((artifact) => {
                const { impactDataRelationship, ...rest } = artifact;
                return rest;
            });

        const enrichedArtifacts =
            await this.relateHistoricalArtifactsAndMetrics(
                organizationTeamAndData,
                teamProjectSettings,
                metricsMapped,
                artifactsMapped,
                currentArtifacts,
                currentArtifactsWithoutImpactDataRelationship,
                impactDataRelationships,
            );

        const enrichedArtifactsWithSumarization =
            await this.summarizeRelatedData(
                organizationTeamAndData,
                enrichedArtifacts.currentArtifactsWithRelatedData,
                enrichedArtifacts.payload,
            );

        return enrichedArtifactsWithSumarization;
    }

    //#region Get Team Data
    private async getTeamContextData(
        organizationAndTeamData: OrganizationAndTeamData,
        isCodeManagementConfigured: boolean,
        isProjectManagementConfigured: boolean,
    ) {
        const METRICS_HISTORY_CONFIG = {
            PAST_METRICS_COUNT: 3,
            DAYS_INTERVAL: 7,
            START_DATE: new Date(
                new Date().setMonth(new Date().getMonth() - 1),
            ),
            END_DATE: new Date(),
        };

        const artifacts =
            await this.teamArtifactsService.getTeamArtifactsByWeeksLimit(
                organizationAndTeamData,
                4,
                'all',
            );

        const flowMetrics = isProjectManagementConfigured
            ? await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                  organizationAndTeamData,
                  MetricsConversionStructure.METRICS_TREND,
                  {
                      howManyMetricsInThePast:
                          METRICS_HISTORY_CONFIG.PAST_METRICS_COUNT,
                      daysInterval: METRICS_HISTORY_CONFIG.DAYS_INTERVAL,
                      weekDay: this.getAdjustedWeekDay(),
                      analysisPeriod: {
                          startTime: METRICS_HISTORY_CONFIG.START_DATE,
                          endTime: METRICS_HISTORY_CONFIG.END_DATE,
                      },
                  },
              )
            : null;

        const doraMetrics = isCodeManagementConfigured
            ? await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                  organizationAndTeamData,
                  MetricsConversionStructure.METRICS_TREND,
                  {
                      howManyMetricsInThePast:
                          METRICS_HISTORY_CONFIG.PAST_METRICS_COUNT,
                      daysInterval: METRICS_HISTORY_CONFIG.DAYS_INTERVAL,
                      weekDay: this.getAdjustedWeekDay(),
                      analysisPeriod: {
                          startTime: METRICS_HISTORY_CONFIG.START_DATE,
                          endTime: METRICS_HISTORY_CONFIG.END_DATE,
                      },
                  },
              )
            : null;

        return { artifacts, flowMetrics, doraMetrics };
    }

    private async getTeamProjectSettings(organizationAndTeamData) {
        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        const orderedBoardColumns = await this.mapBoardColumns(
            columnsConfig.allColumns,
        );

        const teamMethodology =
            await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                organizationAndTeamData,
            );

        const doingColumn =
            await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.DOING_COLUMN,
                organizationAndTeamData,
            );

        const waitingColumns =
            await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.WAITING_COLUMNS,
                organizationAndTeamData,
            );

        return {
            teamMethodology,
            boardColumns: orderedBoardColumns,
            doingColumn: doingColumn.configValue,
            waitingColumns: waitingColumns.configValue,
        };
    }
    //#endregion

    //#region Mappers
    private async mapBoardColumns(allColumns) {
        return allColumns.map((column, index) => ({
            columnId: column.id,
            columnName: column.name,
            columnType: column.column,
            order: index + 1,
        }));
    }

    private async mapTeamArtifacts(
        teamArtifacts: TeamArtifactsEntity[],
    ): Promise<ITeamArtifactToEnrichData[]> {
        return Promise.resolve(
            teamArtifacts.map((artifact) => ({
                uuid: artifact?.uuid,
                name: artifact?.name,
                title: artifact?.title,
                formattedAnalysisInitialDate: moment(
                    artifact.analysisInitialDate,
                ).format('DD/MM/YYYY'),
                formattedAnalysisFinalDate: moment(
                    artifact.analysisFinalDate,
                ).format('DD/MM/YYYY'),
                analysisInitialDate: artifact?.analysisInitialDate,
                analysisFinalDate: artifact?.analysisFinalDate,
                description: artifact?.description,
                resultType: artifact?.resultType,
                impactLevel: artifact?.impactLevel,
                howIsIdentified: artifact?.howIsIdentified,
                whyIsImportant: artifact?.whyIsImportant,
                frequencyType: artifact?.frequenceType,
            })),
        );
    }

    private async mapTeamMetrics(flowMetrics, doraMetrics) {
        const mappedMetrics: any = {};

        const bugRatioMapper = new BugRatioMapper();
        const throughputMapper = new ThroughputMapper();
        const leadTimeInWipMapper = new LeadTimeInWipMapper();
        const leadTimeByColumnMapper = new LeadTimeByColumnMapper();
        const leadTimeForChangeMapper = new LeadTimeForChangeMapper();
        const deployFrequencyMapper = new DeployFrequencyMapper();

        if (flowMetrics?.bugRatio) {
            mappedMetrics.bugRatio = bugRatioMapper.map(flowMetrics.bugRatio);
        }

        if (flowMetrics?.throughput) {
            mappedMetrics.throughput = throughputMapper.map(
                flowMetrics.throughput,
            );
        }

        if (flowMetrics?.leadTimeInWip) {
            mappedMetrics.leadTimeInWip = leadTimeInWipMapper.map(
                flowMetrics.leadTimeInWip,
            );
        }

        if (flowMetrics?.leadTimeByColumn) {
            mappedMetrics.leadTimeByColumn = leadTimeByColumnMapper.map(
                flowMetrics.leadTimeByColumn,
            );
        }

        if (doraMetrics?.leadTimeForChange) {
            mappedMetrics.leadTimeForChange = leadTimeForChangeMapper.map(
                doraMetrics.leadTimeForChange,
            );
        }

        if (doraMetrics?.deployFrequency) {
            mappedMetrics.deployFrequency = deployFrequencyMapper.map(
                doraMetrics.deployFrequency,
            );
        }

        return mappedMetrics;
    }

    private async mapImpactorArtifactsAndMetrics(
        currentArtifacts: any[],
    ): Promise<any> {
        const impactDataRelationships = {};

        const artifactNames = currentArtifacts.map((artifact) => artifact.name);

        for (const artifactName of artifactNames) {
            const artifactStructure = artifactsStructure.find(
                (artifact) => artifact.name === artifactName,
            );

            if (artifactStructure && artifactStructure.impactDataRelationship) {
                const impactedBy =
                    artifactStructure.impactDataRelationship.impactedBy;

                if (!impactDataRelationships[artifactName]) {
                    impactDataRelationships[artifactName] = {
                        indicator: artifactName,
                        impactedBy: {
                            metrics: [],
                            artifacts: [],
                        },
                    };
                }

                for (const impact of impactedBy) {
                    if (impact.category === 'teamMetric') {
                        impactDataRelationships[
                            artifactName
                        ].impactedBy.metrics.push({
                            name: impact.name,
                            howItRelates: impact.howItRelates,
                        });
                    } else if (impact.category === 'teamArtifact') {
                        impactDataRelationships[
                            artifactName
                        ].impactedBy.artifacts.push({
                            name: impact.name,
                            howItRelates: impact.howItRelates,
                        });
                    }
                }
            }
        }

        return impactDataRelationships;
    }
    //#endregion

    //#region Prompts
    private async relateHistoricalArtifactsAndMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
        teamProjectSettings: any,
        historicalTeamMetrics: any,
        historicalTeamArtifacts: any,
        completeCurrentArtifacts: any,
        currentTeamArtifacts: any,
        impactDataRelationships: any,
    ): Promise<any> {
        try {
            let payload: any;

            const llm = await getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_ALL,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            payload = {
                teamMetricsHistory: historicalTeamMetrics ?? null,
                teamArtifactsHistory: historicalTeamArtifacts ?? null,
                currentTeamArtifacts: currentTeamArtifacts ?? null,
                teamProjectSettings: teamProjectSettings ?? null,
                impactDataRelationships: impactDataRelationships ?? null,
            };

            const prompt_relate_data =
                await this.promptService.getCompleteContextPromptByName(
                    'prompt_enrichTeamArtifacts_relateData',
                    {
                        organizationAndTeamData,
                        promptIsForChat: false,
                        payload: payload,
                    },
                );

            const enrichedArtifacts = safelyParseMessageContent(
                (
                    await llm.invoke(prompt_relate_data, {
                        metadata: {
                            submodule: 'EnrichTeamArtifacts',
                            module: 'TeamArtifacts',
                            teamId: organizationAndTeamData.teamId,
                        },
                    })
                ).content,
            );

            const completeCurrentTeamArtifacts = await this.completeData(
                enrichedArtifacts.indicatorsAnalyzed,
                completeCurrentArtifacts,
                payload.teamMetricsHistory,
                payload.teamArtifactsHistory,
            );

            const currentArtifactsWithRelatedData =
                await this.validateRelatedData(
                    completeCurrentTeamArtifacts,
                    impactDataRelationships,
                );

            return { currentArtifactsWithRelatedData, payload };
        } catch (error) {
            this.logger.error({
                message: 'Error while trying to relate artifacts and metrics',
                context: EnrichTeamArtifactsUseCase.name,
                serviceName: 'EnrichTeamArtifactsUseCase',
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    private async summarizeRelatedData(
        organizationAndTeamData,
        currentArtifactsWithRelatedData,
        payload,
    ): Promise<any> {
        try {
            payload.currentArtifactsWithRelatedData =
                currentArtifactsWithRelatedData;

            const llm = await getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_ALL,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            const prompt_relate_data =
                await this.promptService.getCompleteContextPromptByName(
                    'prompt_enrichTeamArtifacts_summarizeRelatedData',
                    {
                        organizationAndTeamData,
                        promptIsForChat: false,
                        payload: payload,
                    },
                );

            const enrichedArtifacts = safelyParseMessageContent(
                (
                    await llm.invoke(prompt_relate_data, {
                        metadata: {
                            submodule: 'EnrichTeamArtifacts',
                            module: 'TeamArtifacts',
                            teamId: organizationAndTeamData.teamId,
                        },
                    })
                ).content,
            );

            const currentArtifactsWithSumarization =
                await this.mergeRelatedData(
                    enrichedArtifacts.indicatorsAnalyzed,
                    payload.currentArtifactsWithRelatedData,
                );

            return { currentArtifactsWithSumarization, payload };
        } catch (error) {
            this.logger.error({
                message:
                    'Error while trying to summarize the related team artifacts',
                context: EnrichTeamArtifactsUseCase.name,
                serviceName: 'EnrichTeamArtifactsUseCase',
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }
    //#endregion

    //#region Complete Data
    private async completeData(
        currentArtifactsAnalyzed: Partial<TeamArtifactsEntity>,
        completeCurrentTeamArtifacts,
        teamMetricsHistory,
        teamArtifactsHistory,
    ) {
        const completeMainArtifacts = await this.completeMainArtifactsData(
            currentArtifactsAnalyzed,
            completeCurrentTeamArtifacts,
        );

        const completeMetrics = await this.completeMetricsData(
            completeMainArtifacts,
            teamMetricsHistory,
        );

        const completeArtifacts = await this.completeArtifactsData(
            completeMetrics,
            teamArtifactsHistory,
        );

        return completeArtifacts;
    }

    private async completeMainArtifactsData(
        currentArtifactsAnalyzed,
        teamArtifactsCompleteData,
    ) {
        const historyMap = teamArtifactsCompleteData.reduce((map, artifact) => {
            map[artifact.uuid] = artifact;
            return map;
        }, {});

        currentArtifactsAnalyzed.forEach((artifact) => {
            const artifactDetails = historyMap[artifact.uuid];
            if (artifactDetails) {
                Object.assign(artifact, artifactDetails);
            }
        });

        return currentArtifactsAnalyzed;
    }

    private async completeMetricsData(
        currentArtifactsAnalyzed,
        teamMetricsHistory,
    ) {
        currentArtifactsAnalyzed.forEach((artifact) => {
            if (artifact.relatedData && artifact.relatedData.metrics) {
                artifact.relatedData.metrics.forEach((metric) => {
                    const normalizedTeamMetricsHistory =
                        this.normalizeKeys(teamMetricsHistory);
                    const history =
                        normalizedTeamMetricsHistory[metric.name.toLowerCase()];
                    if (history) {
                        metric.dataHistory = history.dataHistory;
                    }
                });
            }
        });

        return currentArtifactsAnalyzed;
    }

    private async completeArtifactsData(
        currentArtifactsAnalyzed,
        teamArtifactsHistory,
    ): Promise<ITeamArtifactToEnrichData[]> {
        const historyMap = teamArtifactsHistory.reduce((map, artifact) => {
            map[artifact.uuid] = artifact;
            return map;
        }, {});

        return currentArtifactsAnalyzed.map((artifact) => {
            if (artifact.relatedData && artifact.relatedData.artifacts) {
                artifact.relatedData.artifacts =
                    artifact.relatedData.artifacts.map((relatedArtifact) => {
                        const artifactDetails =
                            historyMap[relatedArtifact.uuid];
                        if (artifactDetails) {
                            const combinedArtifact = {
                                ...relatedArtifact,
                                ...artifactDetails,
                            };
                            delete combinedArtifact.impactDataRelationship;
                            return combinedArtifact;
                        }
                        return relatedArtifact;
                    });
            }
            return artifact;
        });
    }

    private async mergeRelatedData(
        currentArtifactsAnalyzed,
        teamArtifactsCompleteData,
    ) {
        const artifactDataMap = currentArtifactsAnalyzed.reduce(
            (acc, artifact) => {
                acc[artifact.uuid] = {
                    summaryOfRelatedItems:
                        artifact.relatedData.summaryOfRelatedItems,
                };
                return acc;
            },
            {},
        );

        teamArtifactsCompleteData.forEach((artifact) => {
            const matchedData = artifactDataMap[artifact.uuid];
            if (matchedData) {
                artifact.relatedData.summaryOfRelatedItems =
                    matchedData.summaryOfRelatedItems;
            }
        });

        return teamArtifactsCompleteData;
    }
    //#endregion

    //#region Bulk Update
    private async prepareBulkUpdateData(
        currentArtifactsWithSumarization: any[],
    ): Promise<any[]> {
        currentArtifactsWithSumarization =
            await this.removeFormattedDatesFromArtifacts(
                currentArtifactsWithSumarization,
            );
        currentArtifactsWithSumarization =
            await this.removeFormattedDatesFromRelatedData(
                currentArtifactsWithSumarization,
            );
        return currentArtifactsWithSumarization;
    }

    private async removeFormattedDatesFromArtifacts(
        artifacts: any[],
    ): Promise<any[]> {
        return artifacts.map((artifact) => {
            delete artifact.formattedAnalysisInitialDate;
            delete artifact.formattedAnalysisFinalDate;
            return artifact;
        });
    }

    private async removeFormattedDatesFromRelatedData(
        artifacts: any[],
    ): Promise<any[]> {
        return artifacts.map((artifact) => {
            if (artifact.relatedData) {
                artifact.relatedData.metrics?.forEach((metric) => {
                    delete metric.formattedAnalysisInitialDate;
                    delete metric.formattedAnalysisFinalDate;
                });
                artifact.relatedData.artifacts?.forEach((artifactDetail) => {
                    delete artifactDetail.formattedAnalysisInitialDate;
                    delete artifactDetail.formattedAnalysisFinalDate;
                });
            }
            return artifact;
        });
    }
    //#endregion

    //#region Helper Functions
    private normalizeKeys(obj) {
        return Object.keys(obj).reduce((acc, key) => {
            acc[key.toLowerCase()] = obj[key];
            return acc;
        }, {});
    }

    private async validateRelatedData(
        currentArtifactsWithRelatedData: any[],
        impactDataRelationships: any,
    ): Promise<any[]> {
        return currentArtifactsWithRelatedData.map((artifact) => {
            const indicatorRelationship =
                impactDataRelationships[artifact.name];

            if (indicatorRelationship) {
                const validMetrics = artifact.relatedData.metrics.filter(
                    (metric) =>
                        indicatorRelationship.impactedBy.metrics.some(
                            (relatedMetric) =>
                                relatedMetric.name === metric.name,
                        ),
                );

                const validArtifacts = artifact.relatedData.artifacts.filter(
                    (artifactItem) =>
                        indicatorRelationship.impactedBy.artifacts.some(
                            (relatedArtifact) =>
                                relatedArtifact.name === artifactItem.name,
                        ),
                );

                artifact.relatedData.metrics = validMetrics;
                artifact.relatedData.artifacts = validArtifacts;
            }

            return artifact;
        });
    }

    private getAdjustedWeekDay() {
        const currentDay = new Date().getDay();
        return currentDay === 0 ? 6 : currentDay - 1;
    }
    //#endregion
}
