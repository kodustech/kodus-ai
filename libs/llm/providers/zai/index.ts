/**
 * Z.ai (GLM) provider module — id `zai`, a first-class BRAND.
 *
 * Z.ai has its own API keys, endpoints (`api.z.ai/api/anthropic`, the Coding Plan's
 * `.../api/coding/paas/v4`), card, and curated catalog. GLM speaks the ANTHROPIC
 * wire protocol, so the module is built from the shared `anthropicBrandModule`
 * factory: it owns the brand identity + catalog, and every protocol behavior
 * delegates to the anthropic module over its `anthropic_compatible` transport. The
 * stored `credential.provider` is therefore the brand `zai`, not the transport — so
 * the connected view, "Add model", catalog, and routing all key on the brand with
 * zero transport-to-brand recovery.
 */
import { anthropicBrandModule } from '../anthropic/brand';
import { registerProvider } from '../kernel/registry';
import type { ProviderCatalogModel } from '../kernel/catalog';

// Curated Z.ai models. No `provider` override: the aggregator stamps the module id
// `zai` as BOTH the brand and the stored transport, and the module's build()
// resolves the Anthropic protocol.
const catalog: ProviderCatalogModel[] = [
    {
        id: 'glm-5.2',
        displayName: 'GLM 5.2',
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
];

export const zaiModule = anthropicBrandModule({
    id: 'zai',
    label: 'Z.ai',
    doc: 'https://docs.z.ai',
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
            placeholder: 'https://api.z.ai/api/anthropic',
        },
    ],
});

registerProvider(zaiModule);
