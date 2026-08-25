import type { CatalogModel, ModelListing } from '../kernel/types';

const httpListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_ANTHROPIC_API_KEY',
    url: () => 'https://api.anthropic.com/v1/models',
    headers: ({ apiKey }) => ({
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
    }),
    parse: (body) => {
        const data =
            (body as { data?: Array<{ id: string; display_name?: string }> })
                ?.data ?? [];
        return data.map(
            (m): CatalogModel => ({ id: m.id, name: m.display_name || m.id }),
        );
    },
};

export function anthropicModelListing(providerId: string): ModelListing | null {
    if (providerId === 'anthropic') return httpListing;
    // anthropic_compatible needs the user's baseURL + key, unavailable to this
    // GET endpoint; the UI forces free-form model input for it.
    if (providerId === 'anthropic_compatible') return { kind: 'manual' };
    return null;
}
