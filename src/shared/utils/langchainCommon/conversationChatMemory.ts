import { MongoDBChatMessageHistory } from '@langchain/mongodb';
import { ConversationChain } from 'langchain/chains';
import { getChatGPT } from './document';
import { ChainValues } from '@langchain/core/dist/utils/types';
import { CustomChatMemory } from './customMemory';

/**
 * Creates a new instance of ConversationSummaryBufferMemory with the given chatHistory and summaryPrompt.
 *
 * @param {type} chatHistory - The chat history to initialize the instance with
 * @param {type} summaryPrompt - The prompt for the summary
 * @return {ConversationSummaryBufferMemory} A new instance of ConversationSummaryBufferMemory
 */
const createMemoryInstance = (
    collection: any,
    runParams: any,
    historyNumber: number = 3,
): CustomChatMemory => {
    return new CustomChatMemory({
        chatHistory: new MongoDBChatMessageHistory({
            collection,
            sessionId: runParams.sessionId,
        }),
        memoryKey: 'history',
        k: historyNumber,
        returnMessages: true,
    });
};

/**
 * Asynchronously invokes a conversation chain with the given message and chat prompt.
 *
 * @param {string} message - the message to be used as input for the conversation chain
 * @param {string} chatPrompt - the prompt to be used for the conversation chain
 * @return {Promise<any>} a promise that resolves to the result of invoking the conversation chain
 */
const invokeConversationChain = async (
    message,
    chatPrompt,
    memory: CustomChatMemory,
    metadata: any,
    configs?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
    },
) => {
    const chain = new ConversationChain({
        llm: getChatGPT(configs || { verbose: true }),
        prompt: chatPrompt,
        memory: memory,
    });

    const chain_ = await chain.invoke(
        { input: message },
        { metadata: metadata },
    );

    return chain_;
};

/**
 * Asynchronous function to handle conversation chat memory.
 *
 * @param {any} collection - The collection to store chat history.
 * @param {string} chatPrompt - The prompt for the chat.
 * @param {any} runParams - The parameters for running the function.
 * @return {Promise<any>} A promise that resolves to the result of the conversation chain.
 */
const conversationChatMemory = async (
    collection: any,
    chatPrompt: any,
    runParams: any,
    metadata: any,
    configs?: any,
): Promise<ChainValues> => {
    try {
        const memory = createMemoryInstance(collection, runParams);

        const result = await invokeConversationChain(
            runParams.message,
            chatPrompt,
            memory,
            metadata,
            configs,
        );

        return result;
    } catch (error) {
        console.error(error);
    }
};

export { conversationChatMemory, createMemoryInstance };
