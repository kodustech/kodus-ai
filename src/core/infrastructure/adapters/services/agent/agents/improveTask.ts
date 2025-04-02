import { RunParams } from '@/config/types/general/agentRouter.type';
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
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class ImproveTaskAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'ImproveTaskAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

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

            Your mission is to help me write tasks for the engineering team.

            Remember that you don't know anything about the tasks, only if I send you.  So don't make up any information, if you are not sure about something, please ask for clarification.

            To accomplish that you need to follow these steps:

            1. If this is our first conversation send me a variation of this message keeping the context "Oi! Vai ser um prazer te ajudar a escrever ou melhorar algumas tasks. Para começar, você pode me mandar a descrição direto aqui no chat ou uma key de uma tarefa do Jira (GRE-123 por exemplo). Vamos começar?

            2. You need to understand, step by step if the information that I send to you is enough to improve the task description.
            To help you understand the quality of the description you can follow these instructions (do not send this information ever):

            Dependency on Other Activities: The task must clearly specify what these other activities are and how they affect the delivery.

            Technical Clarity: The task must thoroughly detail the technical requirements, APIs to be used, data format, etc.

            Task Representation: Determine whether it is absolutely clear what value this task adds to the project as a whole.

            Activity Type: Check that the type of activity (bug, feature, technical task, etc.) is unambiguously identified.

            Acceptance Criteria/Definition of Ready: The task must list strict acceptance criteria and the precise definition of when it is considered complete.

            Clear and Assertive Content: The task must be completely free of ambiguities and convey its purpose assertively.

            Use Case: The task must provide a clear and realistic use case, demonstrating its practical application.

            Priority: The task must unquestionably emphasize its priority or urgency in relation to other activities.

            Constraints: The task must highlight specific deadlines, technology, or budget constraints that may impact its execution.

            References: The task must provide links or references to documents that support and complement its execution.

            3. When you understand what information is lacking you can ask me clarifying questions.
            Keep in mind to ask only 3-5 questions.

            4. I'll send you the answers to the questions in the "Answers to the Questions" session below.

            5. *When you have enough information*, you can improve the task description and send me the complete version. You can use this template for that:
            "Descrição:

            Critérios de aceite:

            Casos de uso:

            Dependências: (if exists)

            Pontos de atenção (if exists)"

            -----------
            Observations:
            1. Task information section above has everything you need to understand about task.
            2. Please, only use this template when you have enough information to improve the task description.
            3. If a task description is empty, treat it as if it's a new one. Please ask any questions necessary to create an accurate task description based on the instructions provided above.
            4. If you cannot locate a task in Jira, request an alternative ID or description;
            5. If a user ask you information about a task send to him in a conversational way;
            6. Do not invent, create or make up any information about any task. Always aks for user information.

            Begin!
        `,
        ],
        new MessagesPlaceholder('history'),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
    ]);

    async run(runParams: RunParams): Promise<any> {
        try {
            let response;

            if (Array.isArray(runParams.parameters)) {
                if (
                    runParams.parameters &&
                    runParams.parameters.length > 0 &&
                    runParams.parameters.filter(
                        (item) => item.name === 'workItemId',
                    ).length > 0 &&
                    runParams.organizationAndTeamData.organizationId
                ) {
                    const workItems =
                        await this.projectManagementService.getWorkItemsById({
                            organizationAndTeamData:
                                runParams.organizationAndTeamData,
                            workItems: runParams.parameters.map((workItem) => {
                                return workItem.value;
                            }),
                            filters: {
                                movementFilter: null,
                                expandChangelog: true,
                                showDescription: true,
                            },
                        });

                    response = this.getWorkItemsNarrative(runParams, workItems);
                }
            } else if (!!runParams.parameters) {
                if (runParams.organizationAndTeamData.organizationId) {
                    const { value } = runParams.parameters;
                    const items: string[] = [value];

                    const workItems =
                        await this.projectManagementService.getWorkItemsById({
                            organizationAndTeamData:
                                runParams.organizationAndTeamData,
                            workItems: items,
                            filters: {
                                movementFilter: null,
                                expandChangelog: false,
                                showDescription: true,
                            },
                        });

                    response = this.getWorkItemsNarrative(runParams, workItems);
                }
            }

            return response;
        } catch (error) {
            throw new Error('ImproveTaskAgent error', error);
        }
    }

    private async getWorkItemsNarrative(
        runParams: RunParams,
        workItems: Item[],
    ) {
        try {
            const workItemsNarrative = `### Work Items information: ${this.generateWorkItemsNarrative(
                workItems,
            )}`;

            runParams.message += workItemsNarrative;

            const collection = this.memoryService.getNativeCollection();

            const response = await conversationChatMemory(
                collection,
                this.chatPrompt,
                runParams,
                {
                    module: 'ImproveTaskAgent',
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
            throw new Error('ImproveTaskAgent Get Work Items', error);
        }
    }

    private generateWorkItemsNarrative(workItems: any[]) {
        if (!workItems || workItems?.length <= 0) {
            return 'Unable to find information for this item';
        }

        return workItems.map((workItem) => {
            return `Name: ${workItem.name} \n  Description: ${workItem.description} \n  Assignee: ${workItem?.assignee?.userName} \n  Actual Column: ${workItem?.columnName} \n  Actual Status: ${workItem?.status?.name} \n  CreatedAt: ${workItem?.workItemCreatedAt} \n Type: ${workItem?.workItemType?.name}`;
        });
    }
}
