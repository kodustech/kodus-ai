import type { ModelListing } from '../kernel/types';
import { bearerHeaders, parseOpenAiIds } from '../kernel/listing-helpers';

const httpListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_NOVITA_AI_API_KEY',
    url: () => 'https://api.novita.ai/v3/openai/models',
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function novitaModelListing(providerId: string): ModelListing | null {
    return providerId === 'novita' ? httpListing : null;
}
