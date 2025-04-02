import { Document } from '@langchain/core/documents';
import { ChatOpenAI, OpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import 'dotenv/config';
import { TokenTextSplitter } from 'langchain/text_splitter';
import {
    prompt_getBugTypes,
    prompt_getWaitingColumns,
} from '@/shared/utils/langchainCommon/prompts';
import { prompt_getDoingColumnName } from '@/shared/utils/langchainCommon/prompts/configuration/getDoingColumnName';
import { shouldProcessNotBugItems } from '../helpers';
import { OpenAIAssistantRunnable } from 'langchain/experimental/openai_assistant';
import axios from 'axios';
import { traceable } from 'langsmith/traceable';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '../get-llm-model-provider.util';
import { ChatFireworks } from '@langchain/community/chat_models/fireworks';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { ChatNovitaAI } from '@langchain/community/chat_models/novita';

interface OpenAIEmbeddingResponse {
    data: Array<{
        embedding: number[];
        index: number;
        object: string;
    }>;
    model: string;
    object: string;
}

/**
 * Creates a new document object based on the provided formatted data.
 *
 * @param {any} formattedData - The formatted data used to create the document.
 * @return {Document} The newly created document Langchain object Type.
 */
const createDocument = (
    formattedData: any,
    metaData?: Record<string, any>,
): Document => {
    return new Document({
        pageContent: formattedData,
        metadata: { ...metaData },
    });
};

/**
 * Creates an array of Document objects based on the provided payload.
 *
 * @param {any} payload - The data used to generate the Document objects.
 * @return {Document[]} - An array of Document objects.
 */
const createDataPointDocument = (payload: any): Document[] => {
    return payload.map((data) => {
        const pageContent = `Narrative Entity Extration: ${data.narrativeEntityExtraction.text} |KODUS| Narrative: ${data.questionNarrative}`;

        return createDocument(
            pageContent,
            data.narrativeEntityExtraction.entities,
        );
    });
};

/**
 * Splits the payload into chunks and returns the result asynchronously.
 *
 * @param {any} payload - The payload to be split into chunks.
 * @param {Object} [options] - Optional parameters for chunk size and overlap.
 * @param {number} [options.chunkSize=1000] - The size of each chunk.
 * @param {number} [options.chunkOverlap=100] - The overlap between each chunk.
 * @return {Promise<any>} A promise that resolves to the result of splitting the payload into chunks.
 */
const splitPayloadIntoChunks = async (
    payload: any,
    options?: {
        chunkSize?: number;
        chunkOverlap?: number;
    } | null,
): Promise<any> => {
    const defaultOptions = {
        chunkSize: 1000,
        chunkOverlap: 100,
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    const splitter = new TokenTextSplitter({
        encodingName: 'cl100k_base',
        chunkSize: finalOptions.chunkSize,
        chunkOverlap: finalOptions.chunkOverlap,
    });

    return await splitter.splitDocuments(payload);
};

/**
 * Returns a new instance of ChatOpenAI with the specified options.
 *
 * @param {object} options - An optional object containing the following properties:
 *   - model: A string representing the model to use (default: 'gpt-4-turbo').
 *   - temperature: A number representing the temperature (default: 0).
 *   - maxTokens: A number representing the maximum number of tokens (default: -1).
 * @return {ChatOpenAI} A new instance of ChatOpenAI.
 */
const getChatGPT = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: getLLMModelProviderWithFallback(
            LLMModelProvider.CHATGPT_4_TURBO,
        ),
        temperature: 0,
        cache: true,
        maxRetries: 10,
        maxConcurrency: 10,
        maxTokens: -1,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatOpenAI({
        modelName: finalOptions.model,
        openAIApiKey: process.env.API_OPEN_AI_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        streaming: finalOptions.streaming,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
    });
};

/**
 * Generates an instance of the OpenAI class with the specified options.
 *
 * @param {Object} options - The options for configuring the OpenAI instance. (optional)
 * @param {string} options.model - The model to use. Defaults to 'gpt-3.5-turbo-16k'. (optional)
 * @param {number} options.temperature - The temperature value. Defaults to 0. (optional)
 * @return {OpenAI} An instance of the OpenAI class.
 */
const getOpenAI = (
    options?: {
        model?: string;
        temperature?: number;
    } | null,
): any => {
    const defaultOptions = {
        model: getLLMModelProviderWithFallback(
            LLMModelProvider.CHATGPT_3_5_TURBO,
        ),
        temperature: 0,
        cache: true,
        maxRetries: 10,
        maxConcurrency: 10,
        maxTokens: -1,
        streaming: false,
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new OpenAI({
        modelName: finalOptions.model,
        openAIApiKey: process.env.API_OPEN_AI_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        streaming: finalOptions.streaming,
    });
};

/**
 * Creates a new instance of the OpenAIEmbeddings class.
 *
 * @return {OpenAIEmbeddings} The newly created OpenAIEmbeddings instance.
 */
const getEmbedding = () => {
    return new OpenAIEmbeddings({
        openAIApiKey: process.env.API_OPEN_AI_API_KEY,
        modelName: 'text-embedding-ada-002',
    });
};

const estimateTokenCount = (text: string) => {
    // Convert the string to a Blob and get its size in bytes
    const byteCount = new Blob([text]).size;

    // Estimate token count based on average of 4 bytes per token
    return Math.floor(byteCount / 4);
};

const checkOpenAIResult = (input: any, output: any, bugTypes: any): any => {
    try {
        const inputIds = input
            .filter(
                (workItem: any) =>
                    !shouldProcessNotBugItems(
                        workItem.workItemType.name,
                        bugTypes,
                    ),
            )
            .map((workItem: any) => workItem.workItemId.toString());

        const outputIds: any[] = output.map((item: any) =>
            item.workItemId.toString(),
        ); // Converting to string for comparison

        const outputKeys = output.map((item: any) => item.workItemKey);

        const missingIds: any[] = inputIds.filter(
            (workItemId: number) => !outputIds.includes(workItemId),
        );

        // Helper function to find duplicates
        const findDuplicates = (arr: any[]) =>
            arr.filter((item, index) => arr.indexOf(item) !== index);

        const duplicateIds = findDuplicates(outputIds);
        const duplicateKeys = findDuplicates(outputKeys);

        // Collect objects with issues
        const issuesToReprocess = [];

        // Adding missing objects
        missingIds.forEach((id) => {
            const item = input.find((item) => item.workItemId === id);
            if (item) issuesToReprocess.push(item);
        });

        // Adding objects with duplicate IDs
        duplicateIds.forEach((id) => {
            const items = input.filter((item) => item.workItemId === id);
            issuesToReprocess.push(...items);
        });

        // Adding objects with duplicate keys
        duplicateKeys.forEach((key) => {
            const items = input.filter((item) => item.workItemKey === key);
            issuesToReprocess.push(...items);
        });

        const issuesToReprocessIds = issuesToReprocess.map(
            (item) => item.workItemId,
        );

        const hasIssues = issuesToReprocess.length > 0;

        if (hasIssues) {
            return {
                response: false,
                message: `Issues were identified in the processed items.`,
                issuesToReprocess,
                issuesToReprocessIds,
            };
        }

        return {
            response: true,
            message: `Correct result!`,
        };
    } catch (error) {
        return {
            response: false,
            message: `Error while verifying the result: ${error.message}`,
        };
    }
};

const getOpenAIAssistant = (assistantId: string) => {
    return new OpenAIAssistantRunnable({
        assistantId: assistantId,
        clientOptions: { apiKey: process.env.API_OPEN_AI_API_KEY },
    });
};

const getOpenAIAssistantFileContent = async (fileId: string) => {
    // Langchain does not correctly return the fileContent because it does not accept the arraybuffer parameter.
    const response = await axios({
        url: `https://api.openai.com/v1/files/${fileId}/content`,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: {
            Authorization: `Bearer ${process.env.API_OPEN_AI_API_KEY}`,
        },
    });

    // Retrieve the binary data directly from the response
    return response.data;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const checkOpenAIResult_deprecated = (input: any, output: any) => {
    try {
        const inputIds = input
            .filter(
                (workItem: any) =>
                    workItem.workItemType.name.toLowerCase() !== 'error' &&
                    workItem.workItemType.name.toLowerCase() !== 'bug',
            )
            .map((workItem: any) => workItem.workItemId);

        const outputIds: any[] = output.map((item: any) =>
            item.workItemId.toString(),
        ); // Converting to string for comparison

        const outputKeys = output.map((item: any) => item.workItemKey);

        const missingIds: any[] = inputIds.filter(
            (workItemId: number) => !outputIds.includes(workItemId),
        );

        if (missingIds.length > 0)
            return {
                response: false,
                message: `Missing WorkItems in the return object: [${missingIds.join(
                    ',',
                )}]`,
            };

        if (inputIds.length !== outputIds.length)
            return {
                response: false,
                message: `Different result sizes between output object and input object.`,
            };

        const hasDuplicateKeys = new Set(outputKeys).size !== outputKeys.length;
        const hasDuplicateIds = new Set(outputIds).size !== outputIds.length;

        if (hasDuplicateIds)
            return {
                response: false,
                message: `There are WorkItems with duplicate IDs in the return object.`,
            };

        if (hasDuplicateKeys)
            return {
                response: false,
                message: `There are WorkItems with duplicate keys in the return object.`,
            };

        return {
            response: true,
            message: `Correct result!`,
        };
    } catch (error) {
        return {
            response: false,
            message: `Error while verifying the result: ${error.message}`,
        };
    }
};

const getWorkItemIdsFromData = (data: any) => {
    const ids: any[] = [];
    data.data.forEach((column: any) => {
        column.workItems.forEach((workItem: any) => {
            ids.push(workItem.id);
        });
    });
    return ids;
};

const getDoingAndWaitingColumns = async (columns) => {
    try {
        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(LLMModelProvider.CHATGPT_4),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const wipColumns = columns
            .filter((column) => {
                return column.column == 'wip';
            })
            .map((column) => {
                return {
                    id: column.id,
                    name: column.name,
                };
            });

        const promptWaitingColumns = prompt_getWaitingColumns(
            JSON.stringify(wipColumns),
        );

        const promptDoingColumn = prompt_getDoingColumnName(
            JSON.stringify(wipColumns),
        );

        const llmWaitingColmmnResponse = JSON.parse(
            String((await llm.invoke(promptWaitingColumns)).content),
        );

        const llmDoingColumnResponse = JSON.parse(
            String((await llm.invoke(promptDoingColumn)).content),
        );

        return {
            waitingColumns: llmWaitingColmmnResponse,
            doingColumn: llmDoingColumnResponse,
        };
    } catch (error) {}
};

const getBugTypes = async (workItemTypes) => {
    try {
        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(LLMModelProvider.CHATGPT_4),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptBugTypes = prompt_getBugTypes(
            JSON.stringify(workItemTypes),
        );

        const llmBugTypesResponse = JSON.parse(
            String((await llm.invoke(promptBugTypes)).content),
        );

        return {
            bugTypes: llmBugTypesResponse,
        };
    } catch (error) {}
};

const traceCustomLLMCall = async (
    inputMessage: any,
    outputMessage: string,
    name?: string,
    model?: string,
) => {
    const messages = [{ role: 'user', content: inputMessage }];

    const chatModel = traceable(
        async ({
            messages,
        }: {
            messages: { role: string; content: string }[];
        }) => {
            return outputMessage;
        },
        {
            run_type: 'llm',
            name: name || 'CustomLLMTracer',
            metadata: {
                ls_provider: 'CustomProvider',
                ls_model_name: model || 'CustomModel',
            },
        },
    );

    return await chatModel({ messages });
};

/**
 * Returns a new instance of ChatAnthropic with the specified options.
 *
 * @param {object} options - An optional object containing the following properties:
 *   - model: A string representing the model to use (default: 'claude-3-sonnet-20240229').
 *   - temperature: A number representing the temperature (default: 0).
 *   - maxTokens: A number representing the maximum number of tokens (default: 4000).
 * @return {ChatAnthropic} A new instance of ChatAnthropic.
 */
const getChatAnthropic = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: getLLMModelProviderWithFallback(
            LLMModelProvider.CLAUDE_3_5_SONNET,
        ),
        temperature: 0,
        maxTokens: 4000,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatAnthropic({
        modelName: finalOptions.model,
        anthropicApiKey: process.env.API_ANTHROPIC_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        callbacks: finalOptions.callbacks,
    });
};

const getChatGemini = (
    options?: {
        model?: string;
        temperature?: number;
        topP?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
) => {
    const defaultOptions = {
        model: getLLMModelProviderWithFallback(LLMModelProvider.GEMINI_1_5_PRO),
        temperature: 0,
        topP: 1,
        maxTokens: 8192,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatGoogleGenerativeAI({
        model: finalOptions.model,
        apiKey: process.env.API_GOOGLE_AI_API_KEY,
        temperature: finalOptions.temperature,
        topP: finalOptions.topP,
        maxOutputTokens: finalOptions.maxTokens,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
    });
};

/**
 * Returns a new instance of ChatFireworks configured to use the Deepseek model
 * through the Fireworks API.
 *
 * @param {object} options - An optional object containing the following properties:
 *   - model: String representing the model (default: 'accounts/fireworks/models/deepseek-v3')
 *   - temperature: Number representing the temperature (default: 0)
 *   - maxTokens: Number representing the maximum number of tokens (default: 4000)
 * @return {ChatFireworks} A new instance of ChatFireworks
 */
const getDeepseekByFireworks = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: 'accounts/fireworks/models/deepseek-v3',
        temperature: 0,
        maxTokens: 4000,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatFireworks({
        modelName: finalOptions.model,
        apiKey: process.env.API_FIREWORKS_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        callbacks: finalOptions.callbacks,
    });
};

const getChatVertexAI = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: getLLMModelProviderWithFallback(
            LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET,
        ),
        temperature: 0,
        maxTokens: 4000,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    const credentials = Buffer.from(
        process.env.API_VERTEX_AI_API_KEY || '',
        'base64',
    ).toString('utf-8');

    return new ChatVertexAI({
        model: finalOptions.model,
        authOptions: {
            credentials: JSON.parse(credentials),
            projectId: JSON.parse(credentials).project_id,
        },
        location: 'us-east5',
        temperature: finalOptions.temperature,
        maxOutputTokens: finalOptions.maxTokens,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
    });
};

const getDeepseekByTogetherAI = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: 'deepseek-ai/DeepSeek-V3',
        temperature: 0,
        maxTokens: 8000,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatTogetherAI({
        model: finalOptions.model,
        togetherAIApiKey: process.env.TOGETHER_AI_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        callbacks: finalOptions.callbacks,
    });
};

const getDeepseekByNovitaAI = (
    options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        verbose?: boolean;
        callbacks?: BaseCallbackHandler[];
    } | null,
): any => {
    const defaultOptions = {
        model: 'deepseek/deepseek_v3',
        temperature: 0,
        maxTokens: 8000,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatNovitaAI({
        model: finalOptions.model,
        apiKey: process.env.API_NOVITA_AI_API_KEY,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        callbacks: finalOptions.callbacks,
    });
};

const getOpenAIEmbedding = async (
    input: string,
    options?: {
        model?: string;
        apiKey?: string;
    },
): Promise<OpenAIEmbeddingResponse> => {
    const defaultOptions = {
        model: 'text-embedding-3-small',
        apiKey: process.env.API_OPEN_AI_API_KEY,
    };

    const config = { ...defaultOptions, ...options };

    const embeddings = new OpenAIEmbeddings({
        openAIApiKey: config.apiKey,
        modelName: config.model,
    });
    const embeddingVector = await embeddings.embedQuery(input);

    return {
        data: [
            {
                embedding: embeddingVector,
                index: 0,
                object: 'embedding',
            },
        ],
        model: config.model,
        object: 'list',
    };
};

export {
    createDocument,
    createDataPointDocument,
    getChatGPT,
    getChatAnthropic,
    getOpenAI,
    getEmbedding,
    splitPayloadIntoChunks,
    estimateTokenCount,
    checkOpenAIResult,
    getWorkItemIdsFromData,
    getDoingAndWaitingColumns,
    getBugTypes,
    getOpenAIAssistant,
    getOpenAIAssistantFileContent,
    traceCustomLLMCall,
    getChatGemini,
    getDeepseekByFireworks,
    getChatVertexAI,
    getDeepseekByNovitaAI,
    getOpenAIEmbedding,
};
