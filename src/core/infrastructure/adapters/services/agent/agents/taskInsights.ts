import { RunParams } from '@/config/types/general/agentRouter.type';
import {
    AGENT_EXECUTION_SERVICE_TOKEN,
    IAgentExecutionService,
} from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import { IAgentExecution } from '@/core/domain/agents/interfaces/agent-execution.interface';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';

import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import { getCurrentDateTimeZoneBR } from '@/shared/utils/transforms/date';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class TaskInsightsProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'TaskInsightsAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        private readonly projectManagementService: ProjectManagementService,
    ) {}

    private chatPrompt = ChatPromptTemplate.fromMessages([
        [
            'system',
            `
            You are Kody, Kodus' software delivery management virtual assistant.
            You have in-depth knowledge of agile methodologies and engineering project management.
            You also have extensive experience leading technology teams.
            Never step out of that role.
            Answer only in Brazilian-Portuguese.

            Your mission is to help me how project and tasks are being managed.

            Remember that you don't know anything about the tasks, only if I send you. So don't make up any information, if you are not sure about something, please ask for clarification.

            To accomplish that you need to follow these steps:

            1. Understand the data and engineering/agile metrics I've send to you below
            2. Understand the project and tasks I've send to you below
            3. Pay attenttion to give great insights.
            4. Pay attention to tasks status, for example if a task is in progress or not.

            Begin!
        `,
        ],
        new MessagesPlaceholder('history'),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
    ]);

    async run(runParams: RunParams): Promise<any> {
        try {
            let workItems;
            let metrics;

            if (
                runParams.parameters.length > 0 &&
                runParams.parameters.filter(
                    (item) => item.name === 'workItemId',
                ).length > 0 &&
                runParams.organizationAndTeamData.organizationId
            ) {
                workItems =
                    await this.projectManagementService.getWorkItemsById({
                        organizationAndTeamData:
                            runParams.organizationAndTeamData,
                        workItems: runParams.parameters,
                    });

                const columnsConfig =
                    await this.projectManagementService.getColumnsConfig({
                        organizationId:
                            runParams.organizationAndTeamData.organizationId,
                    });

                metrics = await this.metricsFactory.calculateForWorkItems(
                    runParams.organizationAndTeamData,
                    workItems,
                    columnsConfig,
                );
            }

            runParams.message += this.generateInsightsNarrative(
                workItems,
                metrics?.lastMetrics,
                metrics?.deliveryDateForWorkItems,
            );

            const collection = this.memoryService.getNativeCollection();

            const response = await conversationChatMemory(
                collection,
                this.chatPrompt,
                runParams,
                {
                    module: 'TaskInsightsAgent',
                    teamId: runParams.organizationAndTeamData.teamId,
                    sessionId: runParams?.sessionId,
                },
                {
                    model: getLLMModelProviderWithFallback(
                        LLMModelProvider.CHATGPT_4_TURBO,
                    ),
                },
            );

            return response;
        } catch (error) {
            console.error(error);
            throw new Error('TaskInsights error', error);
        }
    }

    private generateInsightsNarrative(workItems, metrics, deliveryDates) {
        return `
        ### ### Information about tasks the user needs information about.
        ${this.generateWorkItemsNarrative(workItems)}

        ### Information about user team metrics
        ${this.generateMetricsNarrative(metrics, deliveryDates)}

        ## Contextual information
        Today Date and Hour:${getCurrentDateTimeZoneBR()}
        `;
    }

    private generateWorkItemsNarrative(workItems: Item[]) {
        if (!workItems || workItems?.length <= 0) {
            return 'Unable to find information for this item';
        }

        return workItems.map((workItem) => {
            const changelog = workItem.changelog
                .map((change) =>
                    change.movements.filter(
                        (field) => field.field !== 'description',
                    ),
                )
                .filter((item) => item.length > 0);

            return `Name: ${workItem.name} \n  Description: ${
                workItem.description.content
            } \n  Assignee: ${workItem.assignee.userName} \n  Actual Column: ${
                workItem.columnName
            } \n  Actual Status: ${workItem.status.name} \n  CreatedAt: ${
                workItem.workItemCreatedAt
            } \n Changelog (WorkItem History): ${JSON.stringify(changelog)}`;
        });
    }

    private generateMetricsNarrative(metrics: any[], deliveryDates) {
        if (!metrics || metrics?.length <= 0) {
            return 'This team does not have any metrics yet.';
        }

        return `LeadTimeyByColumn (in hours): ${this.processLeadTimeByColumn(
            metrics,
        )} \n LeadTime (in hours): ${this.processLeadTime(
            metrics,
        )} \n Delivery Date Estimation (based on lead time): ${this.processDeliveryDates(
            deliveryDates,
        )}`;
    }

    private processLeadTimeByColumn(metrics) {
        const leadTimeByColumn = metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME_BY_COLUMN,
        ).value;

        let outputLeadTimeByColumn = '';

        Object.entries(leadTimeByColumn).forEach(([key, value]) => {
            outputLeadTimeByColumn += `"${key}": ${value}, `;
        });

        if (outputLeadTimeByColumn.length > 0) {
            return outputLeadTimeByColumn;
        } else {
            return 'No data available';
        }
    }

    private processLeadTime(metrics) {
        const leadTime = metrics.filter(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME,
        )[0].value.total.percentiles;

        let outputLeadTime = '';

        Object.entries(leadTime).forEach(([key, value]) => {
            outputLeadTime += `"${key}": ${value}, `;
        });

        if (outputLeadTime.length > 0) {
            return outputLeadTime;
        } else {
            return 'No data available';
        }
    }

    private processDeliveryDates(deliveryDates) {
        if (deliveryDates && deliveryDates[0]?.errorMessage) {
            return `No data available: ${deliveryDates?.errorMessage}`;
        }

        return deliveryDates.map((deliveryDate) => {
            return `WorkItem ID: ${deliveryDate?.issueKey}, Work In Progress Start Date: ${deliveryDate?.startDate},
           Delivery Estimation (p50): ${deliveryDate?.p50}, Delivery Estimation (p75): ${deliveryDate?.p75}
        Delivery Estimation (p50): ${deliveryDate?.p95}, Delivery Is Late: ${deliveryDate?.isLate}, WIP Aging: ${deliveryDate?.aging}`;
        });
    }
}
