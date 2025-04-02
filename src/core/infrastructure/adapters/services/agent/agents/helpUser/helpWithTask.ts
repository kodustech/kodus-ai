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
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { Inject, Injectable } from '@nestjs/common';
import { ProjectManagementService } from '../../../platformIntegration/projectManagement.service';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class HelpWithTaskAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'HelpWithTaskAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(AGENT_EXECUTION_SERVICE_TOKEN)
        private readonly agentExecutionService: IAgentExecutionService,

        private readonly projectManagementService: ProjectManagementService,
    ) {}

    private chatPrompt = ChatPromptTemplate.fromMessages([
        [
            'system',
            `
            You are a project manager for a software engineering team.

            You have knowledge about agile best practices and management of software development activities. Your goal is to help the developers on your team fully understand what needs to be delivered in each of the issues, and how they will deliver that result.

            Never deviate from this role.

            Your mission is to help me understand how to complete my task. If something is unclear or if you identify areas that require more details, ask relevant questions.

            Remember, your answer should be based solely on the issue description I provided; do not make anything up.

            Whenever I ask you a question, you must consult the complete description of the issue and check if it has the necessary information to answer me. Otherwise, you should analyze our chat conversation and see if I provided you something related to the question. And if you find nothing, you should ask me for more details, but never make anything up.

            Use clear and concise language in your answers.

            Response Standard: You SHOULD NOT repeat or rephrase the content of the issue description unless I explicitly ask for it. Upon receiving the description, you should simply tell me that you've received it and ask how you can assist me.
            `,
        ],
        new MessagesPlaceholder('history'),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
    ]);

    async run(runParams: RunParams): Promise<any> {
        try {
            let workItems;

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

                if (!workItems || workItems.length === 0) {
                    workItems = {
                        errorMessage:
                            'WorkItem not found. Ask for new Id or description.',
                    };

                    runParams.message += workItems.errorMessage;
                } else {
                    runParams.message +=
                        this.generateWorkItemsNarrative(workItems);
                }
            }

            const collection = this.memoryService.getNativeCollection();

            const response = await conversationChatMemory(
                collection,
                this.chatPrompt,
                runParams,
                {
                    module: 'HelpWithTaskAgent',
                    teamId: runParams.organizationAndTeamData.teamId,
                    sessionId: runParams?.sessionId,
                },
                {
                    model: getLLMModelProviderWithFallback(
                        LLMModelProvider.CHATGPT_4_TURBO,
                    ),
                },
            );

            this.saveAgentExecution({
                message: runParams.message,
                responseMessage: response.response,
                teamId: runParams.organizationAndTeamData.teamId,
                agentName: 'HelpWithTaskAgent',
                platformUserId: runParams.userId,
            });

            return response;
        } catch (error) {
            throw new Error('HelpWithTaskAgent error', error);
        }
    }

    private saveAgentExecution(data: Omit<IAgentExecution, 'uuid'>): void {
        setImmediate(async () => {
            try {
                this.agentExecutionService.register(data);
            } catch (error) {
                throw new Error(
                    'HelpWithTaskAgent Save Agent Execution',
                    error,
                );
            }
        });
    }

    private generateWorkItemsNarrative(workItems: Item[]) {
        return workItems.map((workItem) => {
            return `Name: ${workItem.name} \n  Description: ${workItem?.description} \n  Assignee: ${workItem?.assignee?.userName} \n  Actual Column: ${workItem.columnName} \n  Actual Status: ${workItem.status.name} \n  CreatedAt: ${workItem.workItemCreatedAt} \n Type: ${workItem.workItemType.name}`;
        });
    }
}
