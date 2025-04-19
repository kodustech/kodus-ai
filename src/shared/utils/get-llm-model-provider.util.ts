import { LLMModelProvider } from '../domain/enums/llm-model-provider.enum';

export function getLLMModelProviderWithFallback(
    modelProvider: LLMModelProvider,
): string {
    const envKeyMap: Record<LLMModelProvider, string> = {
        [LLMModelProvider.CHATGPT_3_5_TURBO]: 'API_LLM_MODEL_CHATGPT_3_5_TURBO',
        [LLMModelProvider.CHATGPT_3_5_TURBO_16K]: 'API_LLM_MODEL_CHATGPT_3_5_TURBO_16K',
        [LLMModelProvider.CHATGPT_4]: 'API_LLM_MODEL_CHATGPT_4',
        [LLMModelProvider.CHATGPT_4_TURBO]: 'API_LLM_MODEL_CHATGPT_4_TURBO',
        [LLMModelProvider.CHATGPT_4_ALL]: 'API_LLM_MODEL_CHATGPT_4_ALL',
        [LLMModelProvider.CHATGPT_4_ALL_MINI]: 'API_LLM_MODEL_CHATGPT_4_ALL_MINI',
        [LLMModelProvider.CLAUDE_3_5_SONNET]: 'API_LLM_MODEL_CLAUDE_3_5_SONNET',
        [LLMModelProvider.GEMINI_1_5_PRO]: 'API_LLM_MODEL_GEMINI_1_5_PRO',
        [LLMModelProvider.GEMINI_1_5_PRO_EXP]: 'API_LLM_MODEL_GEMINI_1_5_PRO_EXP',
        [LLMModelProvider.GEMINI_1_5_FLASH]: 'LLM_MODEL_GEMINI_1_5_FLASH',
        [LLMModelProvider.GEMINI_2_0_FLASH]: 'LLM_MODEL_GEMINI_2_0_FLASH',
        [LLMModelProvider.GEMINI_2_5_PRO_PREVIEW]: 'LLM_MODEL_GEMINI_2_5_PRO_PREVIEW',
        [LLMModelProvider.DEEPSEEK_V3]: 'LLM_MODEL_DEEPSEEK_V3',
        [LLMModelProvider.DEEPSEEK_V3_0324]: 'LLM_MODEL_DEEPSEEK_V3_0324',
        [LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET]:
            'LLM_MODEL_VERTEX_CLAUDE_3_5_SONNET',
    };

    const envValue = process.env[envKeyMap[modelProvider]];

    return envValue || modelProvider;
}
