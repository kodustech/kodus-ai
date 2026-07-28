/**
 * OpenRouter provider module (Phase 1, plan 01-02) — id `open_router`.
 * Reproduces byok-to-vercel.ts's OPEN_ROUTER case: an OpenAI-compatible client
 * pointed at openrouter.ai, gated by the shared json_schema allowlist.
 * OpenRouter has NO LangChain adapter — its build lives inline in byok-to-vercel,
 * which is the source of truth this module mirrors.
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { ModelCapabilities } from '@kodus/kodus-common/llm';
import { shouldEnableJsonSchema } from '@libs/llm/structured-output-gate';
import { registerProvider } from './registry';
import type {
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from './types';

export const openRouterModule: ProviderModule = {
    id: 'open_router',
    label: 'OpenRouter',

    // Provider-pinning lives under settings (order + fallbacks); consumed by the
    // reasoning/routing layer, validated here.
    settingsSchema: z.object({
        baseURL: z.string().optional(),
        openrouterProviderOrder: z.array(z.string()).optional(),
        openrouterAllowFallbacks: z.boolean().optional(),
    }),

    capabilities(_model: string): ModelCapabilities {
        // OpenRouter proxies many upstreams; reasoning support is model-specific
        // and normalized via reasoning.effort, so advertise it generically.
        return {
            supportsTemperature: true,
            supportsReasoning: true,
            reasoningConfig: { type: 'level', options: ['low', 'medium', 'high'] },
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        return createOpenAICompatible({
            name: 'open-router',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://openrouter.ai/api/v1',
            supportsStructuredOutputs:
                opts?.structuredOutputs === true &&
                shouldEnableJsonSchema('open_router', cfg.model, cfg.baseURL),
        })(cfg.model);
    },

    reasoning(
        _cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // OpenRouter normalizes reasoning across upstreams via reasoning.effort.
        return { openrouter: { reasoning: { effort } } };
    },

    normalizeUsage(_raw: unknown): NormalizedUsage {
        return { input: 0, output: 0, reasoning: 0 };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: { input: 0, output: 0, reasoning: 0 }, raw };
    },

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://openrouter.ai/api/v1' },
    ],
};

registerProvider(openRouterModule);
