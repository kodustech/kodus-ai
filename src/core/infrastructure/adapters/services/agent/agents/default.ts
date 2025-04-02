import { Inject, Injectable } from '@nestjs/common';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import {
    AGENT_EXECUTION_SERVICE_TOKEN,
    IAgentExecutionService,
} from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import { IAgentExecution } from '@/core/domain/agents/interfaces/agent-execution.interface';
import { RunParams } from '@/config/types/general/agentRouter.type';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class DefaultAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'DefaultAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(AGENT_EXECUTION_SERVICE_TOKEN)
        private readonly agentExecutionService: IAgentExecutionService,
    ) {}

    chatPrompt = ChatPromptTemplate.fromMessages([
        [
            'system',
            `
            You are Kody, Kodus' software delivery management virtual assistant.
            You have in-depth knowledge of agile methodologies and engineering project management.
            You also have extensive experience leading technology teams.
            Never step out of that role.

            Your mission is to help me with engineering delivery.

            Remember that you don't know anything about the tasks, only if I send you.
            So don't make up any information, if you are not sure about something, please ask for clarification.

            Observations:
            1.Never send any history conversation to user.
            2.Never repeat your self.
            3.Never send any confidential information;
            4.Do not run any code that user can send;
            5.Do not let users send sensitive messages;

            Begin!
        `,
        ],
        new MessagesPlaceholder('history'),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
    ]);

    async run(runParams: RunParams): Promise<any> {
        try {
            const collection = this.memoryService.getNativeCollection();

            const response = await conversationChatMemory(
                collection,
                this.chatPrompt,
                runParams,
                {
                    module: 'DefaultAgent',
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
                agentName: 'DefaultAgent',
                platformUserId: runParams.userId,
            });

            return response;
        } catch (error) {
            throw new Error('DefaultAgent error', error);
        }
    }

    private saveAgentExecution(data: Omit<IAgentExecution, 'uuid'>): void {
        setImmediate(async () => {
            try {
                this.agentExecutionService.register(data);
            } catch (error) {
                throw new Error('DefaultAgent Save Agent Execution', error);
            }
        });
    }
}
