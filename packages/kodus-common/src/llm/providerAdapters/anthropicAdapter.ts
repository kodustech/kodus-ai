import { ChatAnthropic } from '@langchain/anthropic';
import { anthropicCompatibleRootURL } from '../byokProvider.service';
import { resolveModelOptions } from './resolver';
import {
    AdapterBuildParams,
    ProviderAdapter,
    LLM_TIMEOUT_MS,
    LLM_MAX_RETRIES,
} from './types';

export class AnthropicAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatAnthropic {
        const { model, apiKey, baseURL, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            maxReasoningTokens: options?.maxReasoningTokens,
            reasoningLevel: options?.reasoningLevel,
        });

        const maxTokens = resolved.resolvedMaxTokens ?? 4096;

        const isAdaptive = resolved.reasoningType === 'adaptive';
        const isBudget = resolved.reasoningType === 'budget';

        const reasoningBudget = options?.disableReasoning
            ? undefined
            : resolved.supportsReasoning && isBudget
              ? resolved.resolvedReasoningTokens
              : undefined;

        let thinkingConfig: any;
        if (isAdaptive && !options?.disableReasoning) {
            // Opus 4.7+ uses thinking.type="adaptive" without budget_tokens
            thinkingConfig = { type: 'adaptive' };
        } else if (typeof reasoningBudget === 'number') {
            thinkingConfig = {
                type: 'enabled',
                budget_tokens: reasoningBudget,
            };
        }

        // Opus 4.7+ uses outputConfig.effort instead of budget_tokens
        const effortLevel =
            isAdaptive && !options?.disableReasoning
                ? (resolved.resolvedReasoningLevel ?? 'low')
                : undefined;

        const payload: ConstructorParameters<typeof ChatAnthropic>[0] = {
            model,
            apiKey,
            // Anthropic-compatible endpoints (Kimi Code, Z.ai, etc.):
            // ChatAnthropic appends /v1/messages itself, so pass the root.
            ...(baseURL
                ? { anthropicApiUrl: anthropicCompatibleRootURL(baseURL) }
                : {}),
            ...(resolved.temperature !== undefined && !thinkingConfig
                ? { temperature: resolved.temperature }
                : {}),
            maxTokens,
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            callbacks: options?.callbacks,
            maxRetries: LLM_MAX_RETRIES,
            clientOptions: {
                timeout: LLM_TIMEOUT_MS,
            },
        };

        // Apply effort level for adaptive models via model kwargs
        if (effortLevel) {
            (payload as any).modelKwargs = {
                ...((payload as any).modelKwargs ?? {}),
                output_config: { effort: effortLevel },
            };
        }

        return new ChatAnthropic(payload);
    }
}
