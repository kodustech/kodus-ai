import { ChatGoogle } from '@langchain/google-gauth';
import { resolveModelOptions } from './resolver';
import { buildJsonModeOptions } from './jsonMode';
import { supportsBudgetReasoning } from './capabilities';
import { AdapterBuildParams, ProviderAdapter, LLM_TIMEOUT_MS, LLM_MAX_RETRIES } from './types';

export class GoogleGeminiAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatGoogle {
        const { model, apiKey, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            maxReasoningTokens: options?.maxReasoningTokens,
        });

        const reasoningSupported =
            supportsBudgetReasoning(model) &&
            resolved.supportsReasoning &&
            resolved.reasoningType === 'budget' &&
            typeof resolved.resolvedReasoningTokens === 'number';

        const payload: ConstructorParameters<typeof ChatGoogle>[0] = {
            model,
            apiKey,
            ...(resolved.temperature !== undefined
                ? { temperature: resolved.temperature }
                : {}),
            ...(resolved.resolvedMaxTokens
                ? { maxOutputTokens: resolved.resolvedMaxTokens }
                : {}),
            callbacks: options?.callbacks,
            maxRetries: LLM_MAX_RETRIES,
            ...buildJsonModeOptions('google_gemini', options?.jsonMode),
            ...(reasoningSupported
                ? { maxReasoningTokens: resolved.resolvedReasoningTokens }
                : {}),
        };

        return new ChatGoogle(payload);
    }
}
