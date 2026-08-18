/**
 * Model-provider enums + the static model registry. This is the canonical home
 * for the provider/model taxonomy the BYOK layer routes over.
 *
 * IMPORTANT — enum member names AND string values are runtime-load-bearing: they
 * key stored config, DB rows, and cost attribution. Never rename a member or edit
 * a value without a data migration.
 *
 * TOKEN LIMITS — the fat `MODEL_STRATEGIES` table (provider/modelName/…) is gone,
 * and so is its slim successor `MODEL_INPUT_MAX_TOKENS`. Per-model input windows
 * now live where every other capability does: the provider module's
 * `capabilities().maxInputTokens`, resolved for a managed id by
 * `managedModelMaxInputTokens` (libs/llm/managed-model-window.ts). One home.
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
    AZURE = 'azure',
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
}

