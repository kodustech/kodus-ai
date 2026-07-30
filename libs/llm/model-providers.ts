/**
 * Model-provider enums + the static model registry. This is the canonical home
 * for the provider/model taxonomy the BYOK layer routes over.
 *
 * IMPORTANT — enum member names AND string values are runtime-load-bearing: they
 * key stored config, DB rows, and cost attribution. Never rename a member or edit
 * a value without a data migration.
 *
 * COUPLING NOTE — the package's `ModelStrategy` carried a `factory` field typed
 * `(args: FactoryArgs) => BaseChatModel | Runnable` and each `MODEL_STRATEGIES`
 * entry pointed it at a LangChain factory (`getChatGPT`, `getChatAnthropic`, …).
 * That field is the ONLY LangChain coupling in the strategy table, and NO
 * consumer outside the package reads it (the sole external reader,
 * tokenChunking.service.ts, uses only `.modelName` / `.inputMaxTokens`). So the
 * LangChain factory is intentionally NOT copied here — this is the pure,
 * data-only projection of the registry. All non-factory values are verbatim.
 */

export enum BYOKProvider {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE_GEMINI = 'google_gemini',
    GOOGLE_VERTEX = 'google_vertex',
    AMAZON_BEDROCK = 'amazon_bedrock',
    OPENAI_COMPATIBLE = 'openai_compatible',
    ANTHROPIC_COMPATIBLE = 'anthropic_compatible',
    OPEN_ROUTER = 'open_router',
    NOVITA = 'novita',
    MOONSHOT = 'moonshot',
}

export enum LLMModelProvider {
    OPENAI_GPT_4O = 'openai:gpt-4o',
    OPENAI_GPT_4O_MINI = 'openai:gpt-4o-mini',
    OPENAI_GPT_4_1 = 'openai:gpt-4.1',
    OPENAI_GPT_5_1 = 'openai:gpt-5.1',
    OPENAI_GPT_O4_MINI = 'openai:o4-mini',
    CLAUDE_3_5_SONNET = 'anthropic:claude-3-5-sonnet-20241022',
    CLAUDE_SONNET_4_5 = 'anthropic:claude-sonnet-4-5-20250929',
    GEMINI_2_0_FLASH = 'google:gemini-2.0-flash',
    GEMINI_2_5_PRO = 'google:gemini-2.5-pro',
    GEMINI_2_5_FLASH = 'google:gemini-2.5-flash',
    GEMINI_3_PRO_PREVIEW = 'google:gemini-3-pro-preview',
    GEMINI_3_FLASH_PREVIEW = 'google:gemini-3-flash-preview',
    GEMINI_3_1_FLASH_LITE_PREVIEW = 'google:gemini-3.1-flash-lite-preview',
    VERTEX_GEMINI_2_0_FLASH = 'vertex:gemini-2.0-flash',
    VERTEX_GEMINI_2_5_PRO = 'vertex:gemini-2.5-pro',
    VERTEX_GEMINI_2_5_FLASH = 'vertex:gemini-2.5-flash',
    /**
     * @deprecated Non-functional on the legacy v2 engine: its factory
     * (`getChatVertexAI` → langchain `ChatVertexAI`) only speaks the Gemini
     * protocol, so a Claude model id never worked here. Use BYOK (v5) for
     * Claude on Vertex, which routes via `@ai-sdk/google-vertex/anthropic`.
     */
    VERTEX_CLAUDE_3_5_SONNET = 'vertex:claude-3-5-sonnet-v2@20241022',
    NOVITA_DEEPSEEK_V3 = 'novita:deepseek-v3',
    NOVITA_DEEPSEEK_V3_0324 = 'novita:deepseek-v3-0324',
    NOVITA_QWEN3_235B_A22B_THINKING_2507 = 'novita:qwen3-235b-a22b-thinking-2507',
    NOVITA_MOONSHOTAI_KIMI_K2_INSTRUCT = 'novita:moonshotai/kimi-k2-instruct',
    GROQ_MOONSHOTAI_KIMI_K2_ = 'groq:moonshotai/kimi-k2-instruct-0905',
    GROQ_GPT_OSS_120B = 'groq:openai/gpt-oss-120b',
    CEREBRAS_GPT_OSS_120B = 'cerebras:gpt-oss-120b',
    CEREBRAS_GLM_47 = 'cerebras:zai-glm-4.7',
}

/**
 * Static per-model metadata. Data-only projection of the package's
 * `ModelStrategy` — the LangChain `factory` field is deliberately omitted (see
 * the file header). Every remaining field is the pure descriptor the model
 * registry exposes.
 */
export interface ModelStrategy {
    readonly provider: string;
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
        modelName: 'gpt-4o',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_4O_MINI]: {
        provider: 'openai',
        modelName: 'gpt-4o-mini',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_4_1]: {
        provider: 'openai',
        modelName: 'gpt-4.1',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_5_1]: {
        provider: 'openai',
        modelName: 'gpt-5.1',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.OPENAI_GPT_O4_MINI]: {
        provider: 'openai',
        modelName: 'o4-mini',
        defaultMaxTokens: -1,
    },

    // Anthropic
    [LLMModelProvider.CLAUDE_3_5_SONNET]: {
        provider: 'anthropic',
        modelName: 'claude-3-5-sonnet-20241022',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.CLAUDE_SONNET_4_5]: {
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-5-20250929',
        defaultMaxTokens: 16384,
    },

    // Google Gemini
    [LLMModelProvider.GEMINI_2_0_FLASH]: {
        provider: 'google',
        modelName: 'gemini-2.0-flash',
        defaultMaxTokens: 8000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_2_5_PRO]: {
        provider: 'google',
        modelName: 'gemini-2.5-pro',
        defaultMaxTokens: 60000,
        inputMaxTokens: 1000000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_2_5_FLASH]: {
        provider: 'google',
        modelName: 'gemini-2.5-flash',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },

    [LLMModelProvider.GEMINI_3_PRO_PREVIEW]: {
        provider: 'google',
        modelName: 'gemini-3-pro-preview',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_3_FLASH_PREVIEW]: {
        provider: 'google',
        modelName: 'gemini-3-flash-preview',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.GEMINI_3_1_FLASH_LITE_PREVIEW]: {
        provider: 'google',
        modelName: 'gemini-3.1-flash-lite-preview',
        defaultMaxTokens: 65536,
        inputMaxTokens: 1048576,
        maxReasoningTokens: 15000,
    },
    // Vertex AI
    [LLMModelProvider.VERTEX_GEMINI_2_0_FLASH]: {
        provider: 'vertex',
        modelName: 'gemini-2.0-flash',
        defaultMaxTokens: 8000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.VERTEX_GEMINI_2_5_PRO]: {
        provider: 'vertex',
        modelName: 'gemini-2.5-pro',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },
    [LLMModelProvider.VERTEX_GEMINI_2_5_FLASH]: {
        provider: 'vertex',
        modelName: 'gemini-2.5-flash',
        defaultMaxTokens: 60000,
        maxReasoningTokens: 15000,
    },

    [LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET]: {
        provider: 'vertex',
        modelName: 'claude-3-5-sonnet-v2@20241022',
        defaultMaxTokens: 4000,
        inputMaxTokens: 200000,
        maxReasoningTokens: 15000,
    },

    // Deepseek
    [LLMModelProvider.NOVITA_DEEPSEEK_V3]: {
        provider: 'novita',
        modelName: 'deepseek/deepseek_v3',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_DEEPSEEK_V3_0324]: {
        provider: 'novita',
        modelName: 'deepseek/deepseek-v3-0324',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_QWEN3_235B_A22B_THINKING_2507]: {
        provider: 'novita',
        modelName: 'qwen/qwen3-235b-a22b-thinking-2507',
        defaultMaxTokens: 20000,
    },
    [LLMModelProvider.NOVITA_MOONSHOTAI_KIMI_K2_INSTRUCT]: {
        provider: 'novita',
        modelName: 'moonshotai/kimi-k2-instruct',
        defaultMaxTokens: 20000,
    },

    [LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_]: {
        provider: 'groq',
        modelName: 'moonshotai/kimi-k2-instruct-0905',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.GROQ_GPT_OSS_120B]: {
        provider: 'groq',
        modelName: 'openai/gpt-oss-120b',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.CEREBRAS_GLM_47]: {
        provider: 'cerebras',
        modelName: 'zai-glm-4.7',
        defaultMaxTokens: -1,
    },
    [LLMModelProvider.CEREBRAS_GPT_OSS_120B]: {
        provider: 'cerebras',
        modelName: 'gpt-oss-120b',
        defaultMaxTokens: -1,
    },
};
