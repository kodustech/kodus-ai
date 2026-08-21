/**
 * Moonshot (Kimi) provider module — id `moonshot`, a first-class BRAND.
 *
 * Moonshot has its own API keys, endpoints (`api.moonshot.ai/anthropic`, the Kimi
 * Code Plan's `api.kimi.com/coding`), card, and curated catalog. Kimi speaks the
 * ANTHROPIC wire protocol, so the module is built from the shared
 * `anthropicBrandModule` factory: it owns the brand identity + catalog, and every
 * protocol behavior delegates to the anthropic module over its `anthropic_compatible`
 * transport. The stored `credential.provider` is therefore the brand `moonshot`,
 * not the transport — so the connected view, "Add model", catalog, and routing all
 * key on the brand with zero transport-to-brand recovery.
 *
 * (Kimi served over the OpenAI protocol — a manually-typed `api.moonshot.ai/v1`
 * endpoint on the generic OpenAI-compatible custom provider — still routes through
 * the openai module, which keeps the never-downgrade json_schema policy for that
 * path. This brand module is specifically Kimi-over-Anthropic.)
 */
import { anthropicBrandModule } from '../anthropic/brand';
import { registerProvider } from '../kernel/registry';
import { moonshotModelListing } from './listing';
import type { ProviderCatalogModel } from '../kernel/catalog';

// Curated Kimi models (migrated from the web curated-models.json). No `provider`
// override: the aggregator stamps the module id `moonshot` as BOTH the brand and
// the stored transport, and the module's build() resolves the Anthropic protocol.
const catalog: ProviderCatalogModel[] = [
    {
        id: 'kimi-k2.7-code',
        displayName: 'Kimi K2.7 Code',
        tier: 'recommended',
        benchmarkScore: 86,
        description:
            "Moonshot's newest coding model (K2.7) with long thinking / deep reasoning. Developer API. (benchmarkScore is a placeholder pending a real run.)",
        speed: 'medium',
        contextWindow: '256K',
        costTier: '$',
        apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
        defaults: {
            temperature: 1,
            maxOutputTokens: 16384,
            baseURL: 'https://api.moonshot.ai/anthropic',
            reasoningEffort: 'medium',
        },
        docsUrl:
            'https://docs.kodus.io/knowledge_base/en/how-to-use-moonshot-with-kodus',
        variants: [
            {
                id: 'developer',
                label: 'Developer API',
                description:
                    'Pay-per-token, over the native Anthropic protocol (explicit prompt caching + native tool-use).',
                baseURL: 'https://api.moonshot.ai/anthropic',
                apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
            },
            {
                id: 'code-plan',
                label: 'Kimi Code Plan',
                description:
                    'Flat-rate subscription (Anthropic endpoint). Capped at 30 concurrent requests — for heavy automated usage prefer the Developer API.',
                baseURL: 'https://api.kimi.com/coding',
                apiKeyUrl: 'https://www.kimi.com/code',
                maxConcurrentRequests: 30,
            },
        ],
        defaultVariantId: 'developer',
    },
    {
        id: 'kimi-k2.6',
        displayName: 'Kimi K2.6 Coding',
        tier: 'other',
        benchmarkScore: 86,
        description:
            'Previous Moonshot coding model. Superseded by Kimi K2.7 Code.',
        speed: 'medium',
        contextWindow: '256K',
        costTier: '$',
        apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
        defaults: {
            temperature: 1,
            maxOutputTokens: 16384,
            baseURL: 'https://api.moonshot.ai/anthropic',
            reasoningEffort: 'medium',
        },
        docsUrl:
            'https://docs.kodus.io/knowledge_base/en/how-to-use-moonshot-with-kodus',
        variants: [
            {
                id: 'developer',
                label: 'Developer API',
                description:
                    'Pay-per-token, over the native Anthropic protocol (explicit prompt caching + native tool-use).',
                baseURL: 'https://api.moonshot.ai/anthropic',
                apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
            },
            {
                id: 'code-plan',
                label: 'Kimi Code Plan',
                description:
                    'Flat-rate subscription (Anthropic endpoint). Capped at 30 concurrent requests — for heavy automated usage prefer the Developer API.',
                baseURL: 'https://api.kimi.com/coding',
                apiKeyUrl: 'https://www.kimi.com/code',
                maxConcurrentRequests: 30,
            },
        ],
        defaultVariantId: 'developer',
    },
];

export const moonshotModule = {
    ...anthropicBrandModule({
        id: 'moonshot',
        label: 'Moonshot',
        // Moonshot/Kimi developer docs — key setup + the Anthropic-compatible
        // endpoint (api.moonshot.ai/anthropic) this brand builds over.
        doc: 'https://platform.moonshot.ai/docs',
        catalog,
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
                placeholder: 'https://api.moonshot.ai/anthropic',
            },
        ],
    }),
    // Override the factory's manual default: Moonshot's model list IS enumerable
    // at a fixed OpenAI-protocol endpoint (see ./listing), so "Browse all models"
    // can live-list with the stored key alongside the curated picks.
    modelListing: moonshotModelListing,
};

registerProvider(moonshotModule);
