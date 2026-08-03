import type { ModelListing } from '../kernel/types';
import {
    bearerHeaders,
    openAiCompatibleModelsUrl,
    parseOpenAiIds,
} from '../kernel/listing-helpers';

/**
 * Moonshot speaks the OpenAI protocol at a fixed default endpoint
 * (api.moonshot.ai/v1), overridable via the saved slot's baseURL. The old
 * switch-based catalog had NO moonshot case (it fell through to "unsupported");
 * the registry gives it a real listing for free. baseURL is SSRF-gated by the
 * fetcher since a saved slot could override it.
 */
const httpListing: ModelListing = {
    kind: 'http',
    defaultBaseURL: 'https://api.moonshot.ai/v1',
    requiresBaseURL: true,
    timeoutMs: 15_000,
    url: ({ baseURL }) => openAiCompatibleModelsUrl(baseURL as string),
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseOpenAiIds,
};

export function moonshotModelListing(providerId: string): ModelListing | null {
    return providerId === 'moonshot' ? httpListing : null;
}
