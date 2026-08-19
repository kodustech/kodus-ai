/**
 * Z.ai (GLM) provider module — id `zai`, a first-class BRAND.
 *
 * Z.ai has its own API keys, endpoints (`api.z.ai/api/anthropic`, the Coding
 * Plan's `.../api/coding/paas/v4`), card, and curated catalog. Like Moonshot/Kimi,
 * it speaks the ANTHROPIC wire protocol, so its catalog entries build over the ONE
 * shared `anthropic_compatible` transport (`provider` override on the entry) — a
 * single consistent form for every non-Anthropic brand that speaks Anthropic, no
 * per-brand transport id. This module carries the brand identity + catalog; the
 * `build()` below is a contract-complete fallback (the anthropic module does the
 * actual build for `anthropic_compatible` configs).
 */
import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { anthropicCompatibleRootURL } from '@libs/llm/model-builders';
import { registerProvider } from '../kernel/registry';
import { anthropicModule } from '../anthropic';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';

export const zaiModule: ProviderModule = {
    id: 'zai',
    label: 'Z.ai',
    doc: 'https://docs.z.ai',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    // Curated Z.ai models. GLM speaks the Anthropic protocol, so the entry uses
    // the shared `anthropic_compatible` transport (same form as Moonshot/Kimi);
    // the module id `zai` stays the BRAND identity the aggregator stamps.
    catalog: [
        {
            id: 'glm-5.2',
            displayName: 'GLM 5.2',
            provider: 'anthropic_compatible',
            tier: 'recommended',
            benchmarkScore: 84,
            description:
                "Z.ai's latest. Pick Developer API or Coding Plan when you connect.",
            speed: 'medium',
            contextWindow: '200K',
            costTier: '$',
            apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
            defaults: {
                temperature: 0,
                maxOutputTokens: 16384,
                baseURL: 'https://api.z.ai/api/anthropic',
                reasoningEffort: 'medium',
            },
            docsUrl:
                'https://docs.kodus.io/knowledge_base/en/how-to-use-z-ai-with-kodus',
            variants: [
                {
                    id: 'developer',
                    label: 'Developer API',
                    description:
                        'Pay-per-token, over the native Anthropic protocol (explicit prompt caching + native tool-use).',
                    baseURL: 'https://api.z.ai/api/anthropic',
                    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
                },
                {
                    id: 'coding-plan',
                    label: 'Coding Plan',
                    description:
                        'Flat-rate subscription (Anthropic endpoint). Lite/Pro tiers typically allow only 1 concurrent request — bump this in advanced settings if you are on Max.',
                    baseURL: 'https://api.z.ai/api/coding/paas/v4',
                    apiKeyUrl: 'https://z.ai/subscribe',
                    maxConcurrentRequests: 1,
                },
            ],
            defaultVariantId: 'developer',
        },
    ],

    build(cfg: ProviderBuildConfig): LanguageModel {
        // @ai-sdk/anthropic appends `/messages` to the base, so the base must
        // carry the `/v1` suffix — normalize whatever endpoint the user pasted
        // (Developer API vs Coding Plan share this shape).
        return createAnthropic({
            apiKey: cfg.apiKey,
            baseURL: `${anthropicCompatibleRootURL(cfg.baseURL || '')}/v1`,
        })(cfg.model);
    },

    // Intrinsic to the Anthropic wire protocol → shared with the anthropic module.
    capabilities(model: string): ModelCapabilities {
        return anthropicModule.capabilities(model);
    },
    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        return anthropicModule.reasoning!(cfg, effort);
    },
    systemCacheControl(): Record<string, unknown> | undefined {
        return anthropicModule.systemCacheControl!(
            {} as ProviderBuildConfig,
        );
    },
    supportsSamplingParams(cfg: ProviderBuildConfig): boolean {
        return anthropicModule.supportsSamplingParams!(cfg);
    },

    normalize: anthropicModule.normalize,
    normalizeUsage: anthropicModule.normalizeUsage,
    providerOptionsNamespace: () => 'anthropic',

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
        },
    ],

    // No listing — GLM comes from the curated catalog above (manual otherwise).
    modelListing: () => ({ kind: 'manual' }),
};

registerProvider(zaiModule);
