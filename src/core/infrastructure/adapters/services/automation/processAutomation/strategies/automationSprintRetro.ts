import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { ITeamAutomation } from '@/core/domain/automation/interfaces/team-automation.interface';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { ProjectManagementService } from '../../../platformIntegration/projectManagement.service';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { PromptService } from '../../../prompt.service';
import { PinoLoggerService } from '../../../logger/pino.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ISprintService,
    SPRINT_SERVICE_TOKEN,
} from '@/core/domain/sprint/contracts/sprint.service.contract';
import { ISprint } from '@/core/domain/sprint/interface/sprint.interface';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import { CHECKIN_TYPE } from '@/core/domain/checkinHistory/enums/checkin-type.enum';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { MetricTrendAnalyzerAndFormatter } from '../../../metrics/processMetrics/metricAnalyzerAndFormatter';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { formatHours } from '@/shared/utils/formatHours';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { TeamMethodology } from '@/shared/domain/enums/team-methodology.enum';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class AutomationSprintRetroService implements IAutomationFactory {
    automationType = AutomationType.AUTOMATION_SPRINT_RETRO;

    constructor(
        private readonly projectManagementService: ProjectManagementService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(SPRINT_SERVICE_TOKEN)
        private readonly sprintService: ISprintService,
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
        private readonly logger: PinoLoggerService,
        private readonly promptService: PromptService,
        private readonly communicationService: CommunicationService,
    ) {}

    async setup(payload?): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )?.[0];

            const teamMethodology =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                    {
                        organizationId: payload?.organizationId,
                        teamId: payload?.teamId,
                    },
                );

            if (TeamMethodology.SCRUM === teamMethodology) {
                const teamAutomation: ITeamAutomation = {
                    status: true,
                    automation: {
                        uuid: automation.uuid,
                    },
                    team: {
                        uuid: payload.teamId,
                    },
                };

                return this.teamAutomationService.register(teamAutomation);
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Error creating automation for the team',
                context: AutomationSprintRetroService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    async stop(payload?: { teamId: string }): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            return await this.teamAutomationService.update(
                {
                    team: { uuid: payload.teamId },
                    automation: { uuid: automation.uuid },
                },
                {
                    status: false,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error deactivating automation for the team',
                context: AutomationSprintRetroService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    async run(payload?: {
        organizationAndTeamData: OrganizationAndTeamData;
        teamAutomationId: string;
        channelId?: string;
        origin: string;
    }): Promise<any> {
        try {
            const { currentSprint, previousSprint } =
                await this.sprintService.getCurrentAndPreviousSprintForRetro(
                    payload.organizationAndTeamData,
                );

            const workItems =
                await this.projectManagementService.getWorkItemsByCurrentSprint(
                    {
                        organizationAndTeamData:
                            payload.organizationAndTeamData,
                        filters: {
                            movementFilter: (item) =>
                                item.field !== 'description',
                        },
                    },
                );

            const { categoriesForCheckin, artifactsForCheckin } =
                await this.generateSprintResumeAndArtifacts(
                    payload.organizationAndTeamData,
                    workItems,
                    currentSprint,
                    previousSprint,
                );

            const metrics = this.getMetricsFormated(
                currentSprint,
                previousSprint,
            );

            const message =
                await this.communicationService.handlerTemplateMessage({
                    methodName: 'constructSprintRetroCheckinBlocks',
                    organizationAndTeamData: payload.organizationAndTeamData,
                    categoriesForCheckin,
                    artifactsForCheckin,
                    currentSprint,
                    previousSprint,
                    metrics,
                });

            if (!message) {
                this.logger.error({
                    message: 'Error executing automation',
                    context: AutomationSprintRetroService.name,
                    metadata: {
                        organizationId:
                            payload.organizationAndTeamData.organizationId,
                        teamId: payload.organizationAndTeamData.teamId,
                    },
                });

                return 'Error constructing Sprint Retro check-in template';
            }

            const questions = await this.generateQuestions(
                payload.organizationAndTeamData,
                message,
            );

            const messageWithQuestions =
                await this.communicationService.handlerTemplateMessage({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    methodName: 'constructWeeklyCheckinButtons',
                    questions,
                    message,
                });

            const teamChannelId =
                await await this.communicationService.getTeamChannelId(
                    payload.organizationAndTeamData,
                );

            await this.communicationService.saveCheckinHistory({
                date: new Date(),
                message: message,
                type: CHECKIN_TYPE.SPRINT_RETRO,
                organizationAndTeamData: payload.organizationAndTeamData,
            });

            if (teamChannelId || payload.channelId) {
                await this.communicationService.newBlockMessage({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    blocks: messageWithQuestions,
                    channelId: payload.channelId ?? teamChannelId,
                });
                this.createAutomationExecution(
                    {
                        channelIds: teamChannelId,
                        organizationId:
                            payload.organizationAndTeamData.organizationId,
                    },
                    payload.teamAutomationId,
                    payload.origin,
                );
            }

            return 'Automation executed successfully';
        } catch (error) {
            this.logger.error({
                message: 'Error executing automation',
                context: AutomationSprintRetroService.name,
                error: error,
                metadata: {
                    organizationId:
                        payload.organizationAndTeamData.organizationId,
                    teamId: payload.organizationAndTeamData.teamId,
                },
            });
        }
    }

    private getMetricsFormated(
        currentSprint: ISprint,
        previousSprint: ISprint,
    ) {
        const currentSprintMetricsFormated: IMetrics[] =
            currentSprint.value.metrics.map((metric) => ({
                ...metric,
                _uuid: metric.uuid,
                _type: metric.type,
                _value: metric.value,
                _createdAt: new Date(),
            }));

        const previousSprintMetricsFormated: IMetrics[] =
            previousSprint?.value?.metrics?.map((metric) => ({
                ...metric,
                _uuid: metric.uuid,
                _type: metric.type,
                _value: metric.value,
                _createdAt: new Date(previousSprint.completeDate),
            }));

        const metrics: IMetrics[] = currentSprintMetricsFormated.concat(
            previousSprintMetricsFormated ?? [],
        );

        const metricTrendAnalyzerAndFormatter =
            new MetricTrendAnalyzerAndFormatter();

        const { leadTimeInWip, throughput, bugRatio, leadTimeByColumn } =
            this.getMetricsWithHistoric(
                metricTrendAnalyzerAndFormatter,
                metrics,
            );

        return {
            leadTimeInWip,
            throughput,
            bugRatio,
            leadTimeByColumn,
        };
    }

    getMetricsWithHistoric(
        metricTrendAnalyzerAndFormatter: MetricTrendAnalyzerAndFormatter,
        metrics,
    ) {
        const bugRatio =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.BUG_RATIO,
                metrics,
            );

        const currentBugRatio = bugRatio?.reduce((a, b) => {
            return a.date > b.date ? a : b;
        });

        const previousBugRatio = bugRatio
            ?.filter((metric) => metric.date < currentBugRatio.date)
            .reduce((a, b) => {
                return a.date < b.date ? a : b;
            }, null);

        const throughput =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.THROUGHPUT,
                metrics,
            );

        const currentThroughput = throughput?.reduce((a, b) => {
            return a.date > b.date ? a : b;
        });

        const previousThroughput = throughput
            ?.filter((metric) => metric.date < currentThroughput.date)
            .reduce((a, b) => {
                return a.date < b.date ? a : b;
            }, null);

        const leadTimeInWipHistoric =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_IN_WIP,
                metrics,
            );

        const currentLeadTimeInWip = leadTimeInWipHistoric?.reduce((a, b) => {
            return a.date > b.date ? a : b;
        });

        const previousLeadTimeInWip = leadTimeInWipHistoric
            ?.filter((metric) => metric.date < currentLeadTimeInWip.date)
            .reduce((a, b) => {
                return a.date < b.date ? a : b;
            }, null);

        const leadTimeByColumn =
            metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                metrics,
            );

        const currentLeadTimeByColumn = leadTimeByColumn?.reduce((a, b) => {
            return a.date > b.date ? a : b;
        }).original;

        const orderedColumns = Object.keys(currentLeadTimeByColumn).sort(
            (a, b) => a.localeCompare(b),
        );

        const sortedColumns: string[] = [...orderedColumns];

        sortedColumns?.sort(
            (a, b) => currentLeadTimeByColumn[b] - currentLeadTimeByColumn[a],
        );

        const highlightedColumns = sortedColumns?.slice(0, 2).map((column) => ({
            name: column,
            value: currentLeadTimeByColumn[column],
            warning: true,
        }));

        const nonHighlightedColumns = sortedColumns?.slice(2).map((column) => ({
            name: column,
            value: currentLeadTimeByColumn[column],
            warning: false,
        }));

        const columns = [...highlightedColumns, ...nonHighlightedColumns];

        const formatColumns = (columns) => {
            return columns
                .map((column) => {
                    const warningEmoji = column.warning ? '⚠️' : ''; // Adds a warning emoji if the column is highlighted
                    return ` → ${column.name} (${formatHours(
                        column.value.toFixed(2),
                    )}) ${warningEmoji}`;
                })
                .join('\n');
        };

        const leadTimeByColumnMessage = `*Column Lead Time (p75)* \n${formatColumns(
            columns,
        )}`;

        return {
            leadTimeInWip: {
                currentLeadTimeInWip: formatHours(
                    currentLeadTimeInWip.original?.total?.percentiles?.p75,
                ),
                previousLeadTimeInWip: formatHours(
                    previousLeadTimeInWip?.original?.total?.percentiles?.p75,
                ),
                difference: currentLeadTimeInWip?.differences?.find(
                    (el) => el.date === previousLeadTimeInWip?.date,
                )?.difference?.total?.percentiles?.p75,
            },
            throughput: {
                currentThroughput: currentThroughput?.original?.value || 0,

                previousThroughput: previousThroughput?.original?.value || 0,

                difference:
                    currentThroughput?.differences?.find(
                        (el) => el.date === previousThroughput?.date,
                    )?.difference?.value || 0,
            },
            bugRatio: {
                currentBugRatio: currentBugRatio?.original?.value,
                previousBugRatio: formatHours(
                    previousBugRatio?.original?.value,
                ),
                difference: currentBugRatio?.differences?.find(
                    (el) => el.date === previousBugRatio?.date,
                )?.difference?.value,
            },
            leadTimeByColumn: leadTimeByColumnMessage,
        };
    }

    private async generateSprintResumeAndArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: Item[],
        currentSprint: ISprint,
        previousSprint: ISprint,
    ) {
        const promptGeneratSprintResume =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_getMessageInformationForWeekResume',
                {
                    organizationAndTeamData,
                    payload: JSON.stringify(workItems),
                    promptIsForChat: false,
                },
            );

        let previousArtifactsMessage =
            'Previous Artifacts Not Found. This is the first one.';

        if (previousSprint && previousSprint.value?.artifacts?.length > 0) {
            previousArtifactsMessage = `Previous Sprint Artifacts ${JSON.stringify(previousSprint.value?.artifacts)}`;
        }

        const promptRewriteArtifacts =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_rewriteArtifactsForCheckin',
                {
                    organizationAndTeamData,
                    payload: `Team Artifacts For the Last Sprint \n ${JSON.stringify(currentSprint.value?.artifacts)} \n\n ${previousArtifactsMessage}`,
                    promptIsForChat: false,
                },
            );

        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const categoriesForCheckin = safelyParseMessageContent(
            (
                await llm.invoke(promptGeneratSprintResume, {
                    metadata: {
                        module: 'AutomationSprintRetro',
                        teamId: organizationAndTeamData.teamId,
                        submodule: 'SprintResume',
                    },
                })
            ).content,
        ).categories;

        let artifactsForCheckin;

        if (currentSprint.value?.artifacts?.length > 0) {
            artifactsForCheckin = safelyParseMessageContent(
                (
                    await llm.invoke(promptRewriteArtifacts, {
                        metadata: {
                            module: 'AutomationSprintRetro',
                            teamId: organizationAndTeamData.teamId,
                            submodule: 'RewriteArtifacts',
                        },
                    })
                ).content,
            ).artifacts;
        }

        return { categoriesForCheckin, artifactsForCheckin };
    }

    private async generateQuestions(
        organizationAndTeamData: OrganizationAndTeamData,
        message: string,
    ) {
        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptContext =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_weeklyCheckinQuestions',
                {
                    organizationAndTeamData,
                    promptIsForChat: false,
                    payload: JSON.stringify(message),
                },
            );

        return safelyParseMessageContent(
            (
                await llm.invoke(promptContext, {
                    metadata: {
                        module: 'AutomationSprintRetro',
                        teamId: organizationAndTeamData.teamId,
                        submodule: 'GenerateQuestions',
                    },
                })
            ).content,
        ).questions;
    }

    private createAutomationExecution(
        data: any,
        teamAutomationId: string,
        origin: string,
    ) {
        const automationExecution = {
            status: AutomationStatus.SUCCESS,
            dataExecution: data,
            teamAutomation: { uuid: teamAutomationId },
            origin,
        };

        this.automationExecutionService.register(automationExecution);
    }
}
