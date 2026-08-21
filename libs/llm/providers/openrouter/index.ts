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
import { openRouterHonorsJsonSchema } from '@libs/llm/structured-output-gate';
import { registerProvider } from '../kernel/registry';
import { openRouterModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

export const openRouterModule: ProviderModule = {
    id: 'open_router',
    label: 'OpenRouter',
    doc: 'https://openrouter.ai/models',

    // No curated catalog: OpenRouter is a marketplace/aggregator, not a curated
    // brand. It stays connectable (Browse models via its /models listing) and its
    // superseded picks (old Kimi/GLM) are reachable there — just not curated.

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
            // Upstream-dependent; strict json_schema only for allowlisted models
            // (see structured-output-gate), so 'json_object' as the safe default.
            structuredOutput: 'json_object',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        return createOpenAICompatible({
            name: 'open-router',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://openrouter.ai/api/v1',
            supportsStructuredOutputs:
                opts?.structuredOutputs !== false &&
                openRouterHonorsJsonSchema(cfg.model),
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

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // OpenRouter forwards the upstream provider's usage; @ai-sdk/openai-compatible
    // maps it onto the high-level ai@7 LanguageModelUsage shape, so a
    // reasoning-capable upstream (e.g. moonshotai/kimi-*-thinking) surfaces its
    // split at `outputTokenDetails.reasoningTokens` (the top-level `reasoningTokens`
    // is the ai@6 flat fallback; 0 for non-reasoning upstreams). Reasoning is a
    // detail-OF output — `output` is the FULL completion count and is NEVER reduced
    // by reasoning (Q4 double-count trap).
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://openrouter.ai/api/v1' },
    ],
    providerOptionsNamespace: () => 'openrouter',
    modelListing: openRouterModelListing,
};

registerProvider(openRouterModule);
