import { createOpenAI, OpenAIProvider } from '@ai-sdk/openai';
import { embed, EmbeddingModel } from 'ai';
import 'dotenv/config';

/**
 * Plain document shape previously provided by the external documents package.
 * Only `pageContent` and `metadata` are consumed downstream, so a local
 * interface keeps the public API stable without any external dependency.
 */
export interface Document<
    Metadata extends Record<string, any> = Record<string, any>,
> {
    pageContent: string;
    metadata: Metadata;
}

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
 * @return {Document} The newly created plain document object.
 */
const createDocument = (
    formattedData: any,
    metaData?: Record<string, any>,
): Document => {
    return {
        pageContent: formattedData,
        metadata: { ...metaData },
    };
};

const estimateTokenCount = (text: string) => {
    // Convert the string to a Blob and get its size in bytes
    const byteCount = new Blob([text]).size;

    // Estimate token count based on average of 4 bytes per token
    return Math.floor(byteCount / 4);
};

const embeddingModelCache = new Map<string, EmbeddingModel>();

const getEmbeddingModel = (options?: {
    model?: string;
    apiKey?: string;
}): EmbeddingModel => {
    const defaultOptions = {
        model: 'text-embedding-3-small',
        apiKey: process.env.API_OPEN_AI_API_KEY,
    };

    const config = { ...defaultOptions, ...options };

    const cacheKey = `${config.apiKey ?? ''}:${config.model}`;

    let embeddingModel = embeddingModelCache.get(cacheKey);
    if (!embeddingModel) {
        const provider: OpenAIProvider = createOpenAI({
            apiKey: config.apiKey,
        });
        embeddingModel = provider.embedding(config.model);
        embeddingModelCache.set(cacheKey, embeddingModel);
    }

    return embeddingModel;
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

    const embeddingModel = getEmbeddingModel(config);

    const { embedding } = await embed({
        model: embeddingModel,
        value: input,
    });

    return {
        data: [
            {
                embedding,
                index: 0,
                object: 'embedding',
            },
        ],
        model: config.model,
        object: 'list',
    };
};

export { createDocument, estimateTokenCount, getOpenAIEmbedding };
