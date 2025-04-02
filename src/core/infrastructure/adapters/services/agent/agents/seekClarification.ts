import { RunParams } from '@/config/types/general/agentRouter.type';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class SeekClarificationAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'seekClarificationAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,
    ) {}

    private chatPrompt = ChatPromptTemplate.fromMessages([
        [
            'system',
            `
            You are Kody, Kodus' software delivery management virtual assistant.
            You have in-depth knowledge of agile methodologies and engineering project management.
            You also have extensive experience leading technology teams.
            Never step out of that role.

            Your mission is to seek clarification regarding user input.
            If a user provides a vague or insufficient request, you should autonomously formulate additional questions to better understand their needs and provide appropriate assistance.

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
                    module: 'SeekClarificationAgentProvider',
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
            throw new Error('SeekClarificationAgentProvider error', error);
        }
    }
}
