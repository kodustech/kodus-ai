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
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class HelpWithCodeAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'HelpWithCodeAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(AGENT_EXECUTION_SERVICE_TOKEN)
        private readonly agentExecutionService: IAgentExecutionService,
    ) {}

    private chatPrompt = ChatPromptTemplate.fromMessages([
        [
            'system',
            `
            You are a Senior Developer on the Kodus engineering team.
            As an experienced dev, you possess vast technical knowledge and a deep understanding of the complexities of software development. Your role is to guide and advise based on your technical expertise.
            Never deviate from this role.

            Your mission is to assist me with technical queries related to my task. Rely strictly on the task description I provide and avoid making assumptions. Ask clear and direct questions if something is unclear or if you need more information to provide the best technical solution.

            Remember, your response should complement and enrich the task description I provide. Use clear and concise language in your answers.

            Response Standard: You SHOULD NOT repeat or rephrase the content of the issue description; I already have access to this content through Jira. You can simply tell me you've received the description and ask how to assist me.

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
                    module: 'HelpWithCodeAgentProvider',
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
                agentName: 'HelpWithCodeAgentProvider',
                platformUserId: runParams.userId,
            });

            return response;
        } catch (error) {
            throw new Error('HelpWithCodeAgentProvider error', error);
        }
    }

    private saveAgentExecution(data: Omit<IAgentExecution, 'uuid'>): void {
        setImmediate(async () => {
            try {
                this.agentExecutionService.register(data);
            } catch (error) {
                throw new Error(
                    'HelpWithCodeAgentProvider Save Agent Execution',
                    error,
                );
            }
        });
    }
}
