import { ChatPromptTemplate } from '@langchain/core/prompts';
import { encoding_for_model, TiktokenModel } from 'tiktoken';
import { CustomChatMemory } from './customMemory';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '../get-llm-model-provider.util';

/**
 * Calculate the maximum token result based on the payload and chat prompt.
 *
 * @param {string} payload - The input string for token calculation.
 * @param {ChatPromptTemplate} chatPrompt - The chat prompt template object.
 * @return {number} The calculated maximum token result.
 */
const calculateMaxTokenResult = async (
    payload: string,
    chatPrompt: ChatPromptTemplate,
    memory: CustomChatMemory,
) => {
    const tokenLimit = 15500;
    const encoder = encoding_for_model(
        getLLMModelProviderWithFallback(
            LLMModelProvider.CHATGPT_3_5_TURBO_16K,
        ) as TiktokenModel,
    );
    const tokens = encoder.encode(payload);

    const prompt = JSON.stringify(chatPrompt.promptMessages);
    const systemMessage = JSON.parse(prompt).find((item) =>
        item.id.includes('SystemMessagePromptTemplate'),
    );

    const { history } = await memory.loadMemoryVariables({});

    if (!systemMessage) {
        encoder.free();
        return Math.abs(tokens.length - tokenLimit);
    }

    const chatPromptTokens = encoder.encode(
        systemMessage.kwargs.prompt.kwargs.template,
    );
    encoder.free();
    return Math.abs(
        tokens?.length +
            chatPromptTokens?.length +
            history?.length -
            tokenLimit,
    );
};

export { calculateMaxTokenResult };
