import type { ModelListing } from '../kernel/types';
import { bearerHeaders, parseOpenAiIds } from '../kernel/listing-helpers';

const httpListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_OPEN_ROUTER_API_KEY',
    url: () => 'https://openrouter.ai/api/v1/models',
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function openRouterModelListing(providerId: string): ModelListing | null {
    return providerId === 'open_router' ? httpListing : null;
}
