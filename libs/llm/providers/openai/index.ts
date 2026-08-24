/**
 * OpenAI provider module (Phase 1, plan 01-01) — the tracer.
 *
 * Serves BOTH `openai` (native `@ai-sdk/openai`) and `openai_compatible`
 * (`@ai-sdk/openai-compatible`, baseURL-driven) — they share a build that
 * branches on the provider id. Reproduces byok-to-vercel.ts's OPENAI /
 * OPENAI_COMPATIBLE cases exactly (same apiKey/baseURL/structured-output gate),
 * so routing this provider through the registry is a no-behavior-change move.
 *
 * capabilities() is a minimal openai-faithful version for the tracer; the full
 * capability table + the 6 extended fields are folded in 01-04. normalize/
 * normalizeUsage are declared stubs (Phase 3 owns them).
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import {
    openAiCompatibleHonorsJsonSchema,
    isNeverDowngradeModel,
} from '@libs/llm/structured-output-gate';
import { registerProvider } from '../kernel/registry';
import { isOpenAiReasoner, openaiReasoningConfig } from './reasoning';
import { openAiModelListing } from './listing';
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

/**
 * Native OpenAI model families that honor strict `response_format: json_schema`
 * out of the box (the gpt-* / o-series / chatgpt lines). Used only to keep the
 * provider-blind capabilities() honest: everything else served over
 * `openai_compatible` is an unknown upstream that must NOT claim json_schema.
 */
function isNativeOpenAiModel(model: string): boolean {
    return isOpenAiReasoner(model) || /^(gpt|chatgpt|o[0-9])/i.test(model);
}

// The Kimi / Moonshot never-downgrade policy (`isNeverDowngradeModel`) now lives
// in the shared structured-output-gate leaf so the moonshot module shares the
// SAME policy — see the import above. build() still honors it as an ADDITIVE
// override on top of `shouldEnableJsonSchema` (D-00b, Pitfall 2).

export const openaiModule: ProviderModule = {
    id: 'openai',
    aliases: ['openai_compatible'],
    label: 'OpenAI',
    doc: 'https://platform.openai.com/docs/models',

    // Curated OpenAI models (migrated from the web curated-models.json). Native
    // transport ⇒ no per-model `provider` override.
    catalog: [
        {
            id: 'gpt-5.4',
            displayName: 'GPT-5.4',
            tier: 'recommended',
            benchmarkScore: 85,
            description:
                'Latest OpenAI flagship. Consistent low latency and broad knowledge.',
            speed: 'fast',
            contextWindow: '400K',
            costTier: '$$$',
            apiKeyUrl: 'https://platform.openai.com/api-keys',
            defaults: {
                temperature: 0,
                maxOutputTokens: 16384,
                reasoningEffort: 'medium',
            },
        },
        {
            id: 'gpt-5.2',
            displayName: 'GPT-5.2',
            tier: 'other',
            benchmarkScore: 83.2,
            description: 'Previous GPT generation. Superseded by GPT-5.4.',
            speed: 'fast',
            contextWindow: '400K',
            costTier: '$$$',
            strengths: [
                'Very consistent response times',
                'Clean — few low-value comments',
            ],
            weaknesses: ['Catches noticeably fewer issues than average'],
            apiKeyUrl: 'https://platform.openai.com/api-keys',
            defaults: { temperature: 0, maxOutputTokens: 16384 },
        },
    ],

    settingsSchema: z.object({
        baseURL: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        // o-series / gpt-5 reject `temperature`; reasoning config comes from the
        // central family resolver (single source).
        const reasoner = isOpenAiReasoner(model);
        const reasoningConfig = openaiReasoningConfig(model);
        return {
            // o-series / gpt-5 reject `temperature`; other OpenAI models allow it.
            supportsTemperature: !reasoner,
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            // Provider-level execution capabilities (01-04; per-model refinement
            // is a follow-up — note capabilities(model) can't see openai vs
            // openai_compatible). json_schema is claimed only by native OpenAI
            // families and the never-downgrade Kimi/Moonshot family (D-00b);
            // any other id served over openai_compatible is an unknown upstream
            // that defaults to json_object so it isn't over-promised.
            structuredOutput:
                isNativeOpenAiModel(model) || isNeverDowngradeModel(model)
                    ? 'json_schema'
                    : 'json_object',
            toolCalling: 'native',
            usageGranularity: reasoner ? 'reasoning_split' : 'output_only',
            streaming: true,
            promptCaching: true,
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        // apiKey is already DECRYPTED by the caller (byok-to-vercel).
        const apiKey = cfg.apiKey;
        const baseURL = cfg.baseURL;

        if ((cfg.provider as string) === 'openai_compatible') {
            // openai_compatible is a custom endpoint — there is no sensible
            // default. `@ai-sdk/openai-compatible` throws a cryptic "Invalid URL"
            // on an empty baseURL when it builds the first request; fail loud and
            // actionable at build time instead.
            if (!baseURL) {
                throw new Error(
                    'openai_compatible provider requires a baseURL (none configured on the slot).',
                );
            }
            return createOpenAICompatible({
                name: 'openai-compatible',
                apiKey,
                baseURL,
                // Never-downgrade family wins over the baseURL heuristic: a
                // direct-Moonshot upstream (api.moonshot.ai) keeps json_schema
                // ON even though shouldEnableJsonSchema alone would reject it
                // (D-00b). Unknown upstreams still defer to the heuristic — the
                // capability is additive, not a blanket force-on.
                supportsStructuredOutputs:
                    opts?.structuredOutputs !== false &&
                    (isNeverDowngradeModel(cfg.model) ||
                        openAiCompatibleHonorsJsonSchema(baseURL)),
            })(cfg.model);
        }

        // Native OpenAI (id 'openai'). Only pass baseURL when set — the native
        // SDK has a sensible default and an empty string throws "Invalid URL".
        return createOpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
        })(cfg.model);
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        // openai_compatible upstreams (Kimi/GLM/…) take the standard
        // openai-compatible `thinking` param; native OpenAI takes reasoningEffort.
        if ((cfg.provider as string) === 'openai_compatible') {
            return { openaiCompatible: { thinking: { type: 'enabled' } } };
        }
        return { openai: { reasoningEffort: effort } };
    },

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        {
            key: 'apiKey',
            label: 'API key',
            type: 'password',
            required: true,
            scope: 'top',
        },
        {
            key: 'baseURL',
            label: 'Base URL',
            type: 'url',
            required: false,
            scope: 'top',
            placeholder: 'https://api.openai.com/v1',
        },
    ],
    providerOptionsNamespace: (id) =>
        id === 'openai_compatible' ? 'openaiCompatible' : 'openai',
    // Native OpenAI takes `reasoningEffort` (+ optional serviceTier); an
    // openai_compatible upstream takes the standard `thinking` toggle — so the
    // Custom-override example differs per served id. Mirrors reasoning() above.
    reasoningOverrideExample: (id) =>
        id === 'openai_compatible'
            ? '{\n  "thinking": { "type": "enabled" }\n}'
            : '{\n  "reasoningEffort": "high",\n  "serviceTier": "flex"\n}',
    modelListing: openAiModelListing,
};

registerProvider(openaiModule);
