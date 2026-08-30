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
            // Native OpenAI reasoners OR a recognized compatible-family reasoner
            // (Kimi/GLM/DeepSeek served over openai_compatible — those ids never
            // appear on native OpenAI, so the OR is transport-safe).
            supportsReasoning: !!reasoningConfig || isCompatibleReasoner(model),
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
        if (effort === 'none') {
            // A Kimi/Moonshot model served over `openai_compatible` (a user can
            // point openai_compatible at api.moonshot.ai) THINKS BY DEFAULT — so
            // "off" must be said out loud here too, or the user who picked Off
            // still pays for thinking. Gate on the never-downgrade (Kimi/Moonshot)
            // family so we never send a `thinking` param to an unknown upstream
            // (self-hosted Llama/vLLM) that would reject it. Note this transport
            // does structured via response_format (not forced tool_choice), so it
            // never hit the tool_choice+thinking 400 — this is a cost/consistency
            // fix, not a crash fix.
            // Only the Kimi/Moonshot family is confirmed to accept the openai-
            // compatible `thinking` toggle; and never send `disabled` to an
            // always-thinking variant (k2.7-code/k3) that rejects it — decide via
            // the shared traits.
            if (
                (cfg.provider as string) === 'openai_compatible' &&
                isNeverDowngradeModel(cfg.model) &&
                resolveCompatibleReasoningTraits(cfg.model).canDisableThinking
            ) {
                return { openaiCompatible: { thinking: { type: 'disabled' } } };
            }
            return {};
        }
        // openai_compatible upstreams (Kimi/GLM/…) take the standard
        // openai-compatible `thinking` param; native OpenAI takes reasoningEffort.
        if ((cfg.provider as string) === 'openai_compatible') {
            return { openaiCompatible: { thinking: { type: 'enabled' } } };
        }
        return { openai: { reasoningEffort: effort } };
    },

    // Per-model reasoning facts. openai_compatible thinking models (Kimi/DeepSeek)
    // come from the shared table; native OpenAI reasons on the o-series/gpt-5 line
    // and always does structured via response_format (no forced tool_choice), so
    // planStructuredCall is always 'as-is' for it.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        if ((cfg.provider as string) === 'openai_compatible') {
            return resolveCompatibleReasoningTraits(cfg.model);
        }
        return {
            thinksByDefault: isOpenAiReasoner(cfg.model),
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        };
    },

    // Temperature is a MODEL rule, not just a transport one: a Kimi/GLM served over
    // openai_compatible obeys the SAME always-thinking → temperature-1 pin as it
    // does over the Anthropic protocol (shared family helper). Native OpenAI
    // reasoners (o-series / gpt-5) reject temperature outright; other models are
    // free — matching the `supportsTemperature` capability the UI used before.
    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy | undefined {
        if ((cfg.provider as string) === 'openai_compatible') {
            return compatibleTemperaturePolicy(cfg.model);
        }
        // Native OpenAI: no opinion here — the caller derives it from the static
        // `supportsTemperature` capability (reasoners reject temperature), exactly
        // as before, so native behaviour is unchanged.
        return undefined;
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
