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
import { shouldEnableJsonSchema } from '@libs/llm/structured-output-gate';
import { registerProvider } from './registry';
import type {
    ModelCapabilities,
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
} from './types';

export const novitaModule: ProviderModule = {
    id: 'novita',
    label: 'Novita',

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

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        return createOpenAICompatible({
            name: 'novita',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://api.novita.ai/v3/openai',
            supportsStructuredOutputs:
                opts?.structuredOutputs === true &&
                shouldEnableJsonSchema('novita', cfg.model, cfg.baseURL),
        })(cfg.model);
    },

    // No reasoning() — Novita has no native thinking mapping (default: off).

    normalizeUsage(_raw: unknown): NormalizedUsage {
        return { input: 0, output: 0, reasoning: 0 };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: { input: 0, output: 0, reasoning: 0 }, raw };
    },

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://api.novita.ai/v3/openai' },
    ],
};

registerProvider(novitaModule);
