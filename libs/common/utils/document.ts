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

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const embeddingModelCache = new Map<string, EmbeddingModel>();

/**
 * The ONE platform text-embedding builder. INTENTIONALLY pinned to platform
 * OpenAI — `text-embedding-*` models are OpenAI's, so this must NEVER route
 * through a client's BYOK provider (Moonshot/Anthropic/… don't serve them) nor
 * inherit a forced base URL; the base URL is pinned explicitly and only the
 * platform key comes from the env. Returns null when no platform key is set, so
 * callers fail soft (e.g. the dedup tier falls back to lexical veto).
 *
 * This is the single seam for embeddings — both the fine-tuning suggestion
 * index and the review dedup tier build through here (no inline createOpenAI).
 */
const buildPlatformEmbedder = (options?: {
    model?: string;
    apiKey?: string;
}): EmbeddingModel | null => {
    const apiKey = options?.apiKey ?? process.env.API_OPEN_AI_API_KEY;
    if (!apiKey) {
        return null;
    }
    const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;
    const cacheKey = `${apiKey}:${model}`;

    let embeddingModel = embeddingModelCache.get(cacheKey);
    if (!embeddingModel) {
        const provider: OpenAIProvider = createOpenAI({
            apiKey,
            baseURL: 'https://api.openai.com/v1',
        });
        embeddingModel = provider.embedding(model);
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

    const embeddingModel = buildPlatformEmbedder(config);
    if (!embeddingModel) {
        throw new Error(
            'No platform OpenAI key configured for embeddings (API_OPEN_AI_API_KEY).',
        );
    }

    // Match the previous LangChain `OpenAIEmbeddings` default (`stripNewLines:
    // true`): collapse newlines to spaces before embedding so vectors stay
    // consistent with any already-persisted embedding index.
    const value = input.replace(/\n/g, ' ');

    const { embedding } = await embed({
        model: embeddingModel,
        value,
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

export {
    createDocument,
    estimateTokenCount,
    getOpenAIEmbedding,
    buildPlatformEmbedder,
};
