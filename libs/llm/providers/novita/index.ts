/**
 * Novita provider module (Phase 1, plan 01-02) — id `novita`.
 * Reproduces byok-to-vercel.ts's NOVITA case: an OpenAI-compatible client
 * pointed at Novita's endpoint. No LangChain adapter — built inline today.
 * Novita has no dedicated reasoning branch (varies wildly by upstream), so
 * reasoning() is always off — matching reasoning-options.ts's default.
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import { novitaModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
} from '../kernel/types';
import type { TemperaturePolicy } from '../kernel/model-types';
import {
    resolveCompatibleReasoningTraits,
    compatibleTemperaturePolicy,
    isCompatibleReasoner,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

export const novitaModule: ProviderModule = {
    id: 'novita',
    label: 'Novita',
    doc: 'https://novita.ai/docs/guides/introduction',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        // Novita is an aggregator: it hosts KNOWN reasoning families (Kimi/GLM/
        // DeepSeek) alongside plain models (Llama/Qwen). A model's rules are the
        // MODEL's, not the transport's — so a Kimi here reasons exactly as it does
        // anywhere. Advertise reasoning ONLY for a recognized reasoner; an unknown
        // upstream stays generic (no forced thinking on a plain endpoint).
        const isReasoner = isCompatibleReasoner(model);
        return {
            supportsTemperature: true,
            supportsReasoning: isReasoner,
            structuredOutput: 'json_object',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    // Per-model reasoning facts + temperature, resolved by FAMILY (same shared
    // tables the Anthropic-protocol brands and openai_compatible read), so a Kimi
    // on Novita obeys its always-thinking + temperature-1 rules like everywhere
    // else. Unknown upstreams fall through to the safe generic (no forced thinking,
    // free temperature). The `thinking` param itself is NOT emitted here — Novita's
    // OpenAI-protocol Kimi reasons natively and the effort wire-format over this
    // endpoint is unverified — so the pin is applied where it's safe (traits +
    // temperature), not by forcing a param a plain upstream might reject.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        return resolveCompatibleReasoningTraits(cfg.model);
    },
    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy {
        return compatibleTemperaturePolicy(cfg.model);
    },

    build(
        cfg: ProviderBuildConfig,
        opts?: ProviderBuildOptions,
    ): LanguageModel {
        return createOpenAICompatible({
            name: 'novita',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://api.novita.ai/v3/openai',
            ...(opts?.fetch ? { fetch: opts.fetch } : {}),
            // Novita varies too wildly by upstream to trust strict json_schema;
            // it always falls back to json_object (the removed
            // shouldEnableJsonSchema('novita', …) was a constant false).
            supportsStructuredOutputs: false,
        })(cfg.model);
    },

    // No reasoning() — Novita has no native thinking mapping (default: off).

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://api.novita.ai/v3/openai' },
    ],
    providerOptionsNamespace: () => 'openaiCompatible',
    modelListing: novitaModelListing,
};

registerProvider(novitaModule);
