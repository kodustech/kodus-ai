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
    ProviderModule,
} from '../kernel/types';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

export const novitaModule: ProviderModule = {
    id: 'novita',
    label: 'Novita',
    doc: 'https://novita.ai/docs/guides/introduction',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(_model: string): ModelCapabilities {
        // Reasoning is too upstream-dependent to advertise by default.
        return {
            supportsTemperature: true,
            supportsReasoning: false,
            structuredOutput: 'json_object',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        return createOpenAICompatible({
            name: 'novita',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://api.novita.ai/v3/openai',
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
