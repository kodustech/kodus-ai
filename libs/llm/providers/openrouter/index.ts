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
import {
    compatibleTemperaturePolicy,
    resolveCompatibleReasoningTraits,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
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
import type { TemperaturePolicy } from '../kernel/model-types';
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
            // MUST stay in lockstep with `providerOptionsNamespace` below: the
            // SDK forwards `providerOptions` only under this name or its
            // camelCase form (`providerOptions['open-router'] ?? ['openRouter']`).
            // While this read 'open-router' the module's own `{ openrouter: … }`
            // payload matched NEITHER, so every reasoning effort and every
            // provider pin was silently dropped from the request body — the
            // byok-config-matrix spec now pins this to the wire.
            name: 'openrouter',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://openrouter.ai/api/v1',
            ...(opts?.fetch ? { fetch: opts.fetch } : {}),
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
    // OpenRouter is a TRANSPORT hosting other people's models, so the per-model
    // facts are the same ones every other transport reads — the aggregator does
    // not change what a GLM or a Kimi is. Without this delegation the whole
    // family layer was silently bypassed for 17% of production slots: `z-ai/glm-*`
    // was reported as accepting a FORCED tool_choice (its API is `auto`-only, so
    // a structured call took a path the upstream rejects) and an always-thinking
    // `glm-5.3` got whatever temperature was stored instead of its pin.
    //
    // The shared table keys on the model id and the vendor prefix does not hide
    // it (`z-ai/glm-5.2` still matches GLM). It only knows the compatible
    // brands, so `openai/*` and `anthropic/*` ids fall to the unknown default —
    // unchanged from today, and safe: that default never forces a param.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        return {
            ...resolveCompatibleReasoningTraits(cfg.model),
            // ONE fact the shared table cannot answer, because it is about this
            // TRANSPORT and not the model: sending no reasoning parameter to
            // OpenRouter leaves the upstream's own default in force, it does not
            // disable anything. So we must not impose a family default here —
            // doing so would change what 23 production slots spend, to say what
            // the upstream was already going to do.
            omittingDisablesReasoning: false,
        };
    },

    // Same reason: an always-thinking model pins temperature wherever it runs.
    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy | undefined {
        return compatibleTemperaturePolicy(cfg.model, cfg.reasoningEffort);
    },

    providerOptionsNamespace: () => 'openrouter',
    reasoningOverrideExample: () =>
        '{\n  "reasoning": { "effort": "high" },\n  "ignore": ["deepinfra"]\n}',
    modelListing: openRouterModelListing,
};

registerProvider(openRouterModule);
