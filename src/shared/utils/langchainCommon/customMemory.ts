import {
    InputValues,
    MemoryVariables,
    OutputValues,
    getInputValue,
    getOutputValue,
} from '@langchain/core/memory';
import {
    BaseChatMemory,
    BaseChatMemoryInput,
} from '@langchain/community/memory/chat_memory';
import { encoding_for_model, TiktokenModel } from 'tiktoken';
import { getBufferString } from '@langchain/core/messages';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '../get-llm-model-provider.util';

// Definition of the input for the custom memory
export interface CustomChatMemoryInput extends BaseChatMemoryInput {
    humanPrefix?: string;
    aiPrefix?: string;
    memoryKey?: string;
    k?: number;
}

export class CustomChatMemory
    extends BaseChatMemory
    implements CustomChatMemoryInput
{
    humanPrefix = 'Human';
    aiPrefix = 'AI';
    memoryKey = 'history';
    k = 5;

    constructor(fields?: CustomChatMemoryInput) {
        super({
            returnMessages: fields?.returnMessages ?? false,
            chatHistory: fields?.chatHistory,
            inputKey: fields?.inputKey,
            outputKey: fields?.outputKey,
        });
        this.humanPrefix = fields?.humanPrefix ?? this.humanPrefix;
        this.aiPrefix = fields?.aiPrefix ?? this.aiPrefix;
        this.memoryKey = fields?.memoryKey ?? this.memoryKey;
        this.k = fields?.k ?? this.k;
    }

    get memoryKeys(): string[] {
        return [this.memoryKey];
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async loadMemoryVariables(_values: InputValues): Promise<MemoryVariables> {
        const messages = await this.chatHistory.getMessages();
        let totalTokens = 0;
        const maxTokens = 12000;
        const encoder = encoding_for_model(
            getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ) as TiktokenModel,
        );
        const filteredMessages = [];

        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const tokens = encoder.encode(message.content as string).length;

            if (totalTokens + tokens > maxTokens) break;
            filteredMessages.unshift(message);
            totalTokens += tokens;
        }

        if (this.returnMessages) {
            return { [this.memoryKey]: filteredMessages };
        }
        return {
            [this.memoryKey]: getBufferString(
                filteredMessages,
                this.humanPrefix,
                this.aiPrefix,
            ),
        };
    }

    async saveContext(
        inputValues: InputValues,
        outputValues: OutputValues,
    ): Promise<void> {
        // this is purposefully done in sequence so they're saved in order
        await this.chatHistory.addUserMessage(
            getInputValue(inputValues, this.inputKey),
        );
        await this.chatHistory.addAIChatMessage(
            getOutputValue(outputValues, this.outputKey),
        );
    }
}
