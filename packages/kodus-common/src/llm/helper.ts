import { ChatAnthropic } from '@langchain/anthropic';
import { ChatNovitaAI } from '@langchain/community/chat_models/novita';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Runnable } from '@langchain/core/runnables';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogle } from '@langchain/google-gauth';

type ChatAnthropicOptions = ConstructorParameters<typeof ChatAnthropic>[0] & {
    // Anthropic marks these as nullable which is incompatible with the others
    temperature?: number;
    topP?: number;
};
type ChatOpenAIOptions = ConstructorParameters<typeof ChatOpenAI>[0];
type ChatGoogleAIOptions = ConstructorParameters<typeof ChatGoogle>[0];
type ChatVertexAIOptions = ConstructorParameters<typeof ChatVertexAI>[0];
type ChatNovitaAIOptions = ConstructorParameters<typeof ChatNovitaAI>[0];

type FactoryInput =
    | ChatAnthropicOptions
    | ChatOpenAIOptions
    | ChatGoogleAIOptions
    | ChatVertexAIOptions
    | ChatNovitaAIOptions;

export type FactoryArgs = FactoryInput & { baseURL?: string; json?: boolean };

export const getChatGPT = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4_1].modelName,
        temperature: 0,
        cache: true,
        maxRetries: 10,
        maxConcurrency: 10,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4_1].defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
        baseURL: options?.baseURL ? options.baseURL : null,
        apiKey: options?.apiKey
            ? options.apiKey
            : process.env.API_OPEN_AI_API_KEY,
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatOpenAI({
        modelName: finalOptions.model,
        openAIApiKey: finalOptions.apiKey,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        streaming: finalOptions.streaming,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
        configuration: {
            baseURL: finalOptions.baseURL,
            apiKey: finalOptions.apiKey,
        },
    });
};

const getChatAnthropic = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.CLAUDE_3_5_SONNET].modelName,
        temperature: 0,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.CLAUDE_3_5_SONNET]
                .defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
        json: false,
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

const getChatGemini = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO].modelName,
        temperature: 0,
        topP: 1,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO].defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
        json: false,
        maxReasoningTokens:
            MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO]
                .maxReasoningTokens,
    };

    const finalOptions = options
        ? { ...defaultOptions, ...options }
        : defaultOptions;

    return new ChatGoogle({
        model: finalOptions.model,
        apiKey: process.env.API_GOOGLE_AI_API_KEY,
        temperature: finalOptions.temperature,
        topP: finalOptions.topP,
        maxOutputTokens: finalOptions.maxTokens,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
        maxReasoningTokens: finalOptions.maxReasoningTokens,
    });
};

const getChatVertexAI = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.VERTEX_GEMINI_2_5_PRO]
            .modelName,
        temperature: 0,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.VERTEX_GEMINI_2_5_PRO]
                .defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
        maxReasoningTokens:
            MODEL_STRATEGIES[LLMModelProvider.VERTEX_GEMINI_2_5_PRO]
                .maxReasoningTokens,
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            credentials: JSON.parse(credentials),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            projectId: JSON.parse(credentials).project_id,
        },
        location: 'us-east5',
        temperature: finalOptions.temperature,
        maxOutputTokens: finalOptions.maxTokens,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
        maxReasoningTokens: finalOptions.maxReasoningTokens,
    });
};

const getNovitaAI = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.NOVITA_DEEPSEEK_V3].modelName,
        temperature: 0,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.NOVITA_DEEPSEEK_V3]
                .defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
    };

    if (options?.model) {
        options.model = `${options.model}`;
    }

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

const getGroq = (options?: Partial<FactoryArgs>) => {
    const defaultOptions = {
        model: MODEL_STRATEGIES[LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_]
            .modelName,
        temperature: 0,
        cache: true,
        maxRetries: 10,
        maxConcurrency: 10,
        maxTokens:
            MODEL_STRATEGIES[LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_]
                .defaultMaxTokens,
        verbose: false,
        streaming: false,
        callbacks: [],
        baseURL: options?.baseURL
            ? options.baseURL
            : process.env.API_GROQ_BASE_URL,
        apiKey: options?.apiKey ? options.apiKey : process.env.API_GROQ_API_KEY,
    };

    const cleanOptions = Object.fromEntries(
        Object.entries(options ?? {}).filter(
            ([, value]) => value !== undefined,
        ),
    );

    const finalOptions = cleanOptions
        ? { ...defaultOptions, ...cleanOptions }
        : defaultOptions;

    return new ChatOpenAI({
        modelName: finalOptions.model,
        openAIApiKey: finalOptions.apiKey,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        streaming: finalOptions.streaming,
        verbose: finalOptions.verbose,
        callbacks: finalOptions.callbacks,
        configuration: {
            baseURL: finalOptions.baseURL,
            apiKey: finalOptions.apiKey,
        },
    });
};

export enum LLMModelProvider {
    // OpenAI Models
    OPENAI_GPT_4O = 'openai:gpt-4o',
    OPENAI_GPT_4O_MINI = 'openai:gpt-4o-mini',
    OPENAI_GPT_4_1 = 'openai:gpt-4.1',
    OPENAI_GPT_O4_MINI = 'openai:o4-mini',

    // Anthropic Models
    CLAUDE_3_5_SONNET = 'anthropic:claude-3-5-sonnet-20241022',

    // Google AI Models
    GEMINI_2_0_FLASH = 'google:gemini-2.0-flash',
    GEMINI_2_5_PRO = 'google:gemini-2.5-pro',
    GEMINI_2_5_FLASH = 'google:gemini-2.5-flash',

    // Vertex AI Models (prefixed with 'vertex-' to differentiate)
    VERTEX_GEMINI_2_0_FLASH = 'vertex:gemini-2.0-flash',
    VERTEX_GEMINI_2_5_PRO = 'vertex:gemini-2.5-pro',
    VERTEX_GEMINI_2_5_FLASH = 'vertex:gemini-2.5-flash',
    VERTEX_CLAUDE_3_5_SONNET = 'vertex:claude-3-5-sonnet-v2@20241022',

    // Novita Models
    NOVITA_DEEPSEEK_V3 = 'novita:deepseek-v3',
    NOVITA_DEEPSEEK_V3_0324 = 'novita:deepseek-v3-0324',
    NOVITA_QWEN3_235B_A22B_THINKING_2507 = 'novita:qwen3-235b-a22b-thinking-2507',
    NOVITA_MOONSHOTAI_KIMI_K2_INSTRUCT = 'novita:moonshotai/kimi-k2-instruct',

    // Groq Models (OpenAI compatible)
    GROQ_MOONSHOTAI_KIMI_K2_ = 'groq:moonshotai/kimi-k2-instruct-0905',
    GROQ_GPT_OSS_120B = 'groq:openai/gpt-oss-120b',
}

export interface ModelStrategy {
    readonly provider: string;
    readonly factory: (args: FactoryArgs) => BaseChatModel | Runnable;
    readonly modelName: string;
    readonly defaultMaxTokens: number;
    readonly baseURL?: string;
    readonly inputMaxTokens?: number;
    readonly maxReasoningTokens?: number;
}

export const MODEL_STRATEGIES: Record<LLMModelProvider, ModelStrategy> = {
    // OpenAI
    [LLMModelProvider.OPENAI_GPT_4O]: {
        provider: 'openai',
        factory: getChatGPT,
        modelName: 'gpt-4o',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_4O_MINI]: {
        provider: 'openai',
        factory: getChatGPT,
        modelName: 'gpt-4o-mini',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_4_1]: {
        provider: 'openai',
        factory: getChatGPT,
        modelName: 'gpt-4.1',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_O4_MINI]: {
        provider: 'openai',
        factory: getChatGPT,
        modelName: 'o4-mini',
        defaultMaxTokens: -1,
    },

    // Anthropic
    [LLMModelProvider.CLAUDE_3_5_SONNET]: {
        provider: 'anthropic',
        factory: getChatAnthropic,
        modelName: 'claude-3-5-sonnet-20241022',
        defaultMaxTokens: -1,
    },

    // Google Gemini
    [LLMModelProvider.GEMINI_2_0_FLASH]: {
        provider: 'google',
        factory: getChatGemini,
        modelName: 'gemini-2.0-flash',
        defaultMaxTokens: 8000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_2_5_PRO]: {
        provider: 'google',
        factory: getChatGemini,
        modelName: 'gemini-2.5-pro',
        defaultMaxTokens: 60000,
        inputMaxTokens: 1000000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_2_5_FLASH]: {
        provider: 'google',
        factory: getChatGemini,
        modelName: 'gemini-2.5-flash',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },

    // Vertex AI
    [LLMModelProvider.VERTEX_GEMINI_2_0_FLASH]: {
        provider: 'vertex',
        factory: getChatVertexAI,
        modelName: 'gemini-2.0-flash',
        defaultMaxTokens: 8000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.VERTEX_GEMINI_2_5_PRO]: {
        provider: 'vertex',
        factory: getChatVertexAI,
        modelName: 'gemini-2.5-pro',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.VERTEX_GEMINI_2_5_FLASH]: {
        provider: 'vertex',
        factory: getChatVertexAI,
        modelName: 'gemini-2.5-flash',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },

    [LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET]: {
        provider: 'vertex',
        factory: getChatVertexAI,
        modelName: 'claude-3-5-sonnet-v2@20241022',
        defaultMaxTokens: 4000,
        inputMaxTokens: 200000,
        maxReasoningTokens: 15000,
    },

    // Deepseek
    [LLMModelProvider.NOVITA_DEEPSEEK_V3]: {
        provider: 'novita',
        factory: getNovitaAI,
        modelName: 'deepseek/deepseek_v3',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_DEEPSEEK_V3_0324]: {
        provider: 'novita',
        factory: getNovitaAI,
        modelName: 'deepseek/deepseek-v3-0324',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_QWEN3_235B_A22B_THINKING_2507]: {
        provider: 'novita',
        factory: getNovitaAI,
        modelName: 'qwen/qwen3-235b-a22b-thinking-2507',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_MOONSHOTAI_KIMI_K2_INSTRUCT]: {
        provider: 'novita',
        factory: getNovitaAI,
        modelName: 'moonshotai/kimi-k2-instruct',
        defaultMaxTokens: 20000,
    },

    [LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_]: {
        provider: 'groq',
        factory: getGroq,
        modelName: 'moonshotai/kimi-k2-instruct-0905',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.GROQ_GPT_OSS_120B]: {
        provider: 'groq',
        factory: getGroq,
        modelName: 'openai/gpt-oss-120b',
        defaultMaxTokens: -1,
    },
};
