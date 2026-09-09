/**
 * The Kodus provider's model catalog — curated AND a price list.
 *
 * Every entry here is a model Kodus routes on its own upstream account —
 * Fireworks, for now: a curated set of open models (DeepSeek, Kimi, GLM), none
 * of the frontier closed ones — priced at the upstream's public list rate
 * (USD per 1M tokens). The org is billed for
 * exactly these numbers from its Kodus credits, so the catalog is the billing
 * price list, not a hint: a price change is a code change (reviewed, versioned),
 * never a runtime catalog fetch. `models.dev` is the source the numbers were
 * copied from; the `asOf` date says when.
 *
 * Model ids are `<upstream>/<model>`: the prefix picks the upstream account
 * (`fireworks`), the remainder is the upstream's own model id, passed through
 * verbatim (Fireworks ids carry their own slashes). See `splitKodusModelId`.
 */
import type { CatalogModel, ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';
import type { KodusUpstream } from './model-id';

export { KODUS_UPSTREAMS, type KodusUpstream } from './model-id';

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
        id: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash',
        description:
            'Fast, cheap, 1M context. The model Kodus runs trials on — our default pick.',
        recommended: true,
        pricing: {
            inputPerMillion: 0.22,
            outputPerMillion: 0.66,
            cacheReadPerMillion: 0.007,
        },
    },
    {
        id: 'fireworks/accounts/fireworks/models/deepseek-v4-pro-0813',
        name: 'DeepSeek V4 Pro',
        description: 'Deeper reasoning for large or tricky PRs, still 1M context.',
        recommended: true,
        pricing: {
            inputPerMillion: 1.32,
            outputPerMillion: 3.96,
            cacheReadPerMillion: 0.044,
        },
    },
    {
        id: 'fireworks/accounts/fireworks/models/kimi-k2p7-code',
        name: 'Kimi K2.7 Code',
        description: 'Code-tuned, always thinks. Strong on refactors; 262K context.',
        pricing: {
            inputPerMillion: 0.95,
            outputPerMillion: 4,
            cacheReadPerMillion: 0.19,
        },
    },
    {
        id: 'fireworks/accounts/fireworks/models/glm-5p2',
        name: 'GLM 5.2',
        description: 'Solid all-rounder with 1M context.',
        pricing: {
            inputPerMillion: 1.4,
            outputPerMillion: 4.4,
            cacheReadPerMillion: 0.14,
        },
    },
    {
        id: 'fireworks/accounts/fireworks/models/glm-5p3-flash',
        name: 'GLM 5.3 Flash',
        description: 'Cheapest option; quick reviews on small PRs.',
        pricing: {
            inputPerMillion: 0.15,
            outputPerMillion: 0.5,
            cacheReadPerMillion: 0.03,
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
