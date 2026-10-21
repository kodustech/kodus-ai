import type { ModelListing } from '../kernel/types';
import { bearerHeaders, parseOpenAiIds } from '../kernel/listing-helpers';

/**
 * Moonshot's model LIST is a fixed provider fact at the OpenAI-protocol endpoint
 * `api.moonshot.ai/v1/models` — independent of the CHAT transport this brand
 * builds over (the Anthropic endpoint `api.moonshot.ai/anthropic`). So the URL is
 * hardcoded here and the stored chat baseURL is deliberately IGNORED: listing over
 * `/anthropic/models` would 404. Uses the org's stored key. This powers the "Browse
 * all Moonshot models" live list next to the curated picks; the curated catalog is
 * still the default (it carries the editorial copy + recommendation a raw id list can't).
 *
 * (A Kimi Code Plan key at api.kimi.com may not answer this Developer-API models
 * endpoint — that's fine, the curated cards cover that path.)
 */
const httpListing: ModelListing = {
    kind: 'http',
    timeoutMs: 15_000,
    url: () => 'https://api.moonshot.ai/v1/models',
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function moonshotModelListing(providerId: string): ModelListing | null {
    return providerId === 'moonshot' ? httpListing : null;
}
