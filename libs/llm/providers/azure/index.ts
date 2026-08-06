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
import type {
    ModelCapabilities,
    ModelResult,
    ModelListing,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderModule,
} from '../kernel/types';

/** Best-effort: an Azure deployment named after an OpenAI reasoning family. */
function looksLikeReasoner(deployment: string): boolean {
    return (
        /^o[134](\b|[-_@])/i.test(deployment) ||
        /gpt-5(\b|[-_@])/i.test(deployment)
    );
}

export const azureModule: ProviderModule = {
    id: 'azure',
    label: 'Azure OpenAI',

    settingsSchema: z.object({
        baseURL: z.string().optional(),
        apiVersion: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        // Deployment names are arbitrary, so this is a heuristic, not a contract.
        const reasoner = looksLikeReasoner(model);
        return {
            supportsTemperature: !reasoner,
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

    build(cfg: ProviderBuildConfig): LanguageModel {
        // apiKey is already DECRYPTED by the caller (byok-to-vercel). The slot's
        // `model` is the Azure DEPLOYMENT name; `baseURL` is the resource endpoint.
        return createAzure({
            apiKey: cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            // Classic deployment routing (matches `model` = deployment name).
            useDeploymentBasedUrls: true,
        })(cfg.model);
    },

    // Same high-level LanguageModelUsage shape every other module reads, so cost
    // projection stays one source of truth. Azure reports OpenAI-style usage.
    normalizeUsage(raw: unknown): NormalizedUsage {
        const u =
            (raw as { usage?: Record<string, any> } | undefined)?.usage ?? {};
        return {
            input: u.inputTokens ?? 0,
            output: u.outputTokens ?? 0,
            reasoning:
                u.outputTokenDetails?.reasoningTokens ??
                u.reasoningTokens ??
                0,
        };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: this.normalizeUsage(raw), raw };
    },

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
