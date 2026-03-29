import { ChatAnthropic } from '@langchain/anthropic';
import { resolveModelOptions } from './resolver';
import { AdapterBuildParams, ProviderAdapter, LLM_TIMEOUT_MS, LLM_MAX_RETRIES } from './types';

export class AnthropicAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatAnthropic {
        const { model, apiKey, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
        });

        const maxTokens = resolved.resolvedMaxTokens ?? 4096;

        const reasoningBudget =
            resolved.supportsReasoning && resolved.reasoningType === 'budget'
                ? resolved.resolvedReasoningTokens
                : undefined;

        const payload: ConstructorParameters<typeof ChatAnthropic>[0] = {
            model,
            apiKey,
            ...(resolved.temperature !== undefined &&
            typeof reasoningBudget !== 'number'
                ? { temperature: resolved.temperature }
                : {}),
            maxTokens,
            ...(typeof reasoningBudget === 'number'
                ? {
                      thinking: {
                          type: 'enabled',
                          budget_tokens: reasoningBudget,
                      },
                  }
                : {}),
            callbacks: options?.callbacks,
            maxRetries: LLM_MAX_RETRIES,
            clientOptions: {
                timeout: LLM_TIMEOUT_MS,
            },
        };

        return new ChatAnthropic(payload);
    }
}
