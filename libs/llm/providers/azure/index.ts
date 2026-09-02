/**
 * Azure OpenAI provider module — id `azure`.
 *
 * Azure serves the OpenAI model families (gpt-4o, o-series, …) behind a
 * per-resource endpoint + named DEPLOYMENTS. Built on `@ai-sdk/azure`
 * (`createAzure`), which handles the Azure URL/auth shape natively — the slot's
 * `model` is the DEPLOYMENT name and `baseURL` is the resource endpoint
 * (`https://{resource}.openai.azure.com/openai`). `useDeploymentBasedUrls` keeps
 * the classic `/deployments/{deployment}?api-version=…` routing that existing
 * Azure OpenAI resources use.
 *
 * Capabilities are conservative on purpose: an Azure deployment can be named
 * anything, so model-name heuristics (o-series/gpt-5 → reasoning) are best-effort
 * only. Azure caches prompts implicitly (like OpenAI), so `promptCaching` is true
 * but there is NO `systemCacheControl` inline hint (nothing to attach). Model
 * listing is `manual` — deployments are enumerated via the Azure management API,
 * not the inference key, so the user types the deployment name.
 */
import type { LanguageModel } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import type { TemperaturePolicy } from '../kernel/model-types';
import type {
    ModelCapabilities,
    ModelListing,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { ModelReasoningTraits } from '../kernel/reasoning-traits';
import { NON_REASONING_TRAITS } from '../kernel/reasoning-traits';
import { isOpenAiReasonerId } from '../kernel/model-family';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

/**
 * Best-effort: an Azure deployment named after an OpenAI reasoning family.
 * Azure serves OpenAI models, so the rule is OpenAI's and comes from the model
 * layer — this module had its own near-copy that matched `gpt-5` unanchored and
 * did not know the deep-research line, so the same id was a reasoner here and
 * not one in the openai module. Deployment names are arbitrary, so this stays a
 * heuristic; what changed is that it is the SAME heuristic everywhere.
 */
function looksLikeReasoner(deployment: string): boolean {
    return isOpenAiReasonerId(deployment);
}

/** The o-series / gpt-5 families do not accept `temperature`; everything else
 *  does. One statement, read by both `capabilities()` and `temperaturePolicy()`
 *  below, so the flag and the policy cannot answer differently. */
function azureTemperaturePolicy(deployment: string): TemperaturePolicy {
    return looksLikeReasoner(deployment)
        ? { kind: 'unsupported' }
        : { kind: 'adjustable' };
}

export const azureModule: ProviderModule = {
    id: 'azure',
    label: 'Azure OpenAI',
    doc: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models',

    settingsSchema: z.object({
        baseURL: z.string().optional(),
        apiVersion: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        // Deployment names are arbitrary, so this is a heuristic, not a contract.
        const reasoner = looksLikeReasoner(model);
        return {
            // Derived from the same predicate the policy and the traits use, so
            // the UI cannot offer an effort the module will not send, or hide
            // one it would. It was hardcoded `false` while `reasoning()` did not
            // exist; both halves move together.
            supportsReasoning: reasoner,
            reasoningConfig: reasoner
                ? { type: 'level', options: ['low', 'medium', 'high'] }
                : undefined,
            // Azure = OpenAI models → native strict json_schema; the shared
            // structured-output retry catches a deployment that rejects it.
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: reasoner ? 'reasoning_split' : 'output_only',
            streaming: true,
            // Azure OpenAI caches implicitly (no inline hint) — hence no
            // systemCacheControl() below, exactly like the openai module.
            promptCaching: true,
        };
    },

    build(
        cfg: ProviderBuildConfig,
        opts?: ProviderBuildOptions,
    ): LanguageModel {
        // apiKey is already DECRYPTED by the caller (byok-to-vercel). The slot's
        // `model` is the Azure DEPLOYMENT name; `baseURL` is the resource endpoint.
        return createAzure({
            apiKey: cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            ...(opts?.fetch ? { fetch: opts.fetch } : {}),
            // Classic deployment routing (matches `model` = deployment name).
            useDeploymentBasedUrls: true,
        })(cfg.model);
    },

    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy {
        return azureTemperaturePolicy(cfg.model);
    },

    /**
     * Azure serves the OpenAI families over the SAME Responses API the native
     * module uses — the built client reports `azure.responses` — so the reasoning
     * parameter is OpenAI's `reasoning.effort`, only under Azure's own
     * providerOptions namespace. Having no `reasoning()` meant an o-series or
     * gpt-5 deployment silently ignored whatever effort the customer picked.
     *
     * 'none' emits nothing, matching the native module: the o-series cannot be
     * turned off, and on the gpt-5 line omitting IS the off (its documented
     * default effort is none).
     */
    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none' || !looksLikeReasoner(cfg.model)) {
            return {};
        }
        // camelCase is the SDK's own option name; it renders `reasoning.effort`
        // itself. The snake_case form is spread and then overwritten.
        return { azure: { reasoningEffort: effort } };
    },

    /**
     * Declared rather than inherited. A module with no `reasoningTraits` falls
     * back to `NON_REASONING_TRAITS`, which is not "we don't know" — it is a set
     * of ASSERTIONS (this model does not think; a forced tool_choice is safe)
     * that nobody checked. For an o-series or gpt-5 deployment the first of them
     * is simply false: the model reasons whether or not we ask.
     *
     * What stays true either way is the rest of the OpenAI protocol — a forced
     * tool_choice is accepted alongside reasoning (this is the Anthropic rule,
     * not OpenAI's), and reasoning cannot be turned off on the o-series. Azure
     * exposes no `reasoning()` yet, so nothing here reaches the wire; the point
     * is that the facts are now stated and testable instead of assumed.
     */
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        if (!looksLikeReasoner(cfg.model)) return NON_REASONING_TRAITS;
        return {
            thinksByDefault: true,
            canDisableThinking: false,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        };
    },

    // `@ai-sdk/azure` builds models whose provider id is `azure.responses`
    // (verified against the built model), so `azure` is the key the SDK reads.
    providerOptionsNamespace: () => 'azure',

    // Azure serves OpenAI reasoning models, so the override is OpenAI's
    // `reasoningEffort` (the SDK renders it as `reasoning.effort`), NOT a
    // `thinking` block — matches what `reasoning()` emits: { azure: { reasoningEffort } }.
    reasoningOverrideExample: () => '{\n  "reasoningEffort": "high"\n}',

    // Same high-level LanguageModelUsage shape every other module reads, so cost
    // projection stays one source of truth. Azure reports OpenAI-style usage.
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
            label: 'Resource endpoint',
            type: 'url',
            required: true,
            scope: 'top',
            placeholder: 'https://your-resource.openai.azure.com/openai',
        },
    ],

    // Deployments aren't listable via the inference key → the user enters the
    // deployment name as the model id.
    modelListing(): ModelListing {
        return { kind: 'manual' };
    },
};

registerProvider(azureModule);
