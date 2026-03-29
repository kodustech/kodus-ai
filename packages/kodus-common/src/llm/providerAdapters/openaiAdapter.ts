import { ChatOpenAI } from '@langchain/openai';
import { resolveModelOptions } from './resolver';
import { supportsJsonMode } from './capabilities';
import { AdapterBuildParams, ProviderAdapter, LLM_TIMEOUT_MS, LLM_MAX_RETRIES } from './types';

export class OpenAIAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatOpenAI {
        const { model, apiKey, baseURL, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            maxReasoningTokens: options?.maxReasoningTokens,
        });

        const reasoningEffort =
            resolved.supportsReasoning &&
            resolved.reasoningType === 'level' &&
            resolved.resolvedReasoningLevel
                ? resolved.resolvedReasoningLevel
                : undefined;

        // Check if reasoning should be explicitly disabled (e.g., for GLM models via OpenRouter)
        const disableReasoning = options?.disableReasoning === true;

        const payload: ConstructorParameters<typeof ChatOpenAI>[0] = {
            model,
            apiKey,
            ...(resolved.resolvedMaxTokens
                ? { maxTokens: resolved.resolvedMaxTokens }
                : {}),
            ...(resolved.temperature !== undefined
                ? { temperature: resolved.temperature }
                : {}),
            ...(disableReasoning
                ? {
                      // Pass reasoning: { enabled: false } via modelKwargs for OpenRouter
                      modelKwargs: { reasoning: { enabled: false } },
                  }
                : reasoningEffort
                  ? {
                        reasoning: { effort: reasoningEffort },
                        reasoningEffort,
                    }
                  : {}),
            ...(resolved.supportsReasoning && resolved.reasoningType === 'level'
                ? { useResponsesApi: true }
                : {}),
            ...(options?.jsonMode && supportsJsonMode(model)
                ? {
                      response_format: { type: 'json_object' as const },
                  }
                : {}),
            callbacks: options?.callbacks,
            timeout: LLM_TIMEOUT_MS,
            maxRetries: LLM_MAX_RETRIES,
            configuration: {
                ...(baseURL ? { baseURL } : {}),
            },
        };

        // Debug log to see what's being passed
        if (disableReasoning) {
            console.log('[OpenAIAdapter] Payload with disableReasoning:', JSON.stringify({
                model: payload.model,
                modelKwargs: payload.modelKwargs,
                baseURL: payload.configuration?.baseURL,
            }, null, 2));
        }

        return new ChatOpenAI(payload);
    }
}
