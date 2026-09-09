/**
 * The Kodus provider's model catalog — curated AND a price list.
 *
 * Every entry here is a model Kodus routes on its own upstream account, priced
 * at the upstream's public list rate (USD per 1M tokens). The org is billed for
 * exactly these numbers from its Kodus credits, so the catalog is the billing
 * price list, not a hint: a price change is a code change (reviewed, versioned),
 * never a runtime catalog fetch. `models.dev` is the source the numbers were
 * copied from; the `asOf` date says when.
 *
 * Model ids are `<upstream>/<model>`: the prefix picks the upstream account
 * (`anthropic` | `openai` | `google`), the remainder is the upstream's own model
 * id, passed through verbatim. See `splitKodusModelId` in ./index.ts.
 */
import type { CatalogModel, ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

/** Upstream accounts the Kodus provider can route to. The value is the
 *  registered provider id whose module builds the model. */
export const KODUS_UPSTREAMS = {
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google_gemini',
} as const;

export type KodusUpstream = keyof typeof KODUS_UPSTREAMS;

/** Date the list prices below were copied from models.dev. */
export const KODUS_CATALOG_PRICES_AS_OF = '2026-09-09';

type KodusCatalogEntry = {
    id: `${KodusUpstream}/${string}`;
    name: string;
    description: string;
    recommended?: boolean;
    pricing: NonNullable<CatalogModel['pricing']>;
};

const ENTRIES: KodusCatalogEntry[] = [
    {
        id: 'anthropic/claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'Best balance of review quality and cost. Our default pick.',
        recommended: true,
        pricing: {
            inputPerMillion: 2,
            outputPerMillion: 10,
            cacheReadPerMillion: 0.2,
            cacheWritePerMillion: 2.5,
        },
    },
    {
        id: 'anthropic/claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Deepest reasoning for large or tricky PRs. Premium price.',
        pricing: {
            inputPerMillion: 5,
            outputPerMillion: 25,
            cacheReadPerMillion: 0.5,
            cacheWritePerMillion: 6.25,
        },
    },
    {
        id: 'anthropic/claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        description: 'Fast and cheap for small PRs and summaries.',
        pricing: {
            inputPerMillion: 1,
            outputPerMillion: 5,
            cacheReadPerMillion: 0.1,
            cacheWritePerMillion: 1.25,
        },
    },
    {
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
        description: 'Strong reviewer, follows review focus instructions well.',
        recommended: true,
        pricing: {
            inputPerMillion: 2.5,
            outputPerMillion: 15,
            cacheReadPerMillion: 0.25,
        },
    },
    {
        id: 'openai/gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        description: 'Budget option with solid reasoning.',
        pricing: {
            inputPerMillion: 0.75,
            outputPerMillion: 4.5,
            cacheReadPerMillion: 0.075,
        },
    },
    {
        id: 'openai/gpt-5.6',
        name: 'GPT-5.6',
        description: 'Latest OpenAI flagship.',
        pricing: {
            inputPerMillion: 4,
            outputPerMillion: 20,
            cacheReadPerMillion: 0.4,
            cacheWritePerMillion: 5,
        },
    },
    {
        id: 'google/gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro',
        description: 'Large context, good on big diffs.',
        pricing: {
            inputPerMillion: 2,
            outputPerMillion: 12,
            cacheReadPerMillion: 0.2,
        },
    },
    {
        id: 'google/gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        description: 'Cheapest option that still reasons.',
        pricing: {
            inputPerMillion: 0.75,
            outputPerMillion: 3.75,
            cacheReadPerMillion: 0.075,
        },
    },
];

/** The catalog as the picker sees it. Reasoning support is derived from the
 *  bare upstream model id (the family owner knows), like Vertex/Bedrock do. */
export const KODUS_CATALOG: CatalogModel[] = ENTRIES.map((e) => ({
    ...catalogWithReasoning(e.id, e.name, e.id.split('/').slice(1).join('/')),
    description: e.description,
    recommended: e.recommended,
    pricing: e.pricing,
}));

const BY_ID = new Map(KODUS_CATALOG.map((m) => [m.id, m]));

/** The list price for a catalog model id, or undefined for an id the catalog
 *  does not carry (the runtime never routes those — see the capability gate). */
export function kodusModelPricing(
    modelId: string,
): CatalogModel['pricing'] | undefined {
    return BY_ID.get(modelId)?.pricing;
}

/** Whether the id is one Kodus offers (the catalog is closed — an unlisted id
 *  has no price and therefore cannot be billed, so it must not run). */
export function isKodusCatalogModel(modelId: string): boolean {
    return BY_ID.has(modelId);
}

const STATIC_LISTING: ModelListing = { kind: 'static', models: KODUS_CATALOG };

export function kodusModelListing(providerId: string): ModelListing | null {
    return providerId === 'kodus' ? STATIC_LISTING : null;
}
