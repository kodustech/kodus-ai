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
} from '../kernel/types';
import type { ModelReasoningTraits } from '../kernel/reasoning-traits';
import { NON_REASONING_TRAITS } from '../kernel/reasoning-traits';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

/** Best-effort: an Azure deployment named after an OpenAI reasoning family. */
function looksLikeReasoner(deployment: string): boolean {
    return (
        /^o[134](\b|[-_@])/i.test(deployment) ||
        /gpt-5(\b|[-_@])/i.test(deployment)
    );
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
            supportsReasoning: false, // opt-in reasoning per-deployment is a follow-up
            reasoningConfig: undefined,
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
