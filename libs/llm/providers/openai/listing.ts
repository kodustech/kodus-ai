import type { ModelListing } from '../kernel/types';
import {
    bearerHeaders,
    catalogWithReasoning,
    openAiCompatibleModelsUrl,
    parseOpenAiIds,
} from '../kernel/listing-helpers';

/** Native OpenAI: fixed endpoint, Bearer, reasoning derived from the cap table. */
const nativeListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_OPEN_AI_API_KEY',
    url: () => 'https://api.openai.com/v1/models',
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: (body) => parseOpenAiIds(body).map((m) => catalogWithReasoning(m.id)),
};

/** openai_compatible: the org's OWN baseURL (SSRF-gated by the fetcher), plain
 *  id list — an unknown upstream doesn't get reasoning claims. */
const compatibleListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_OPEN_AI_API_KEY',
    baseURLEnv: 'API_OPENAI_FORCE_BASE_URL',
    defaultBaseURL: 'https://api.openai.com',
    requiresBaseURL: true,
    timeoutMs: 15_000,
    url: ({ baseURL }) => openAiCompatibleModelsUrl(baseURL as string),
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function openAiModelListing(providerId: string): ModelListing | null {
    if (providerId === 'openai_compatible') return compatibleListing;
    if (providerId === 'openai') return nativeListing;
    return null;
}
