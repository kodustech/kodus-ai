import type { ModelListing } from '../kernel/types';
import { catalogWithReasoning } from '../kernel/listing-helpers';

function formatModelName(str: string): string {
    return str
        .split('-')
        .map((word) => {
            if (/^\d+\.\d+$/.test(word)) return word; // keep versions like 2.5
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

const httpListing: ModelListing = {
    kind: 'http',
    apiKeyEnv: 'API_GOOGLE_AI_API_KEY',
    timeoutMs: 10_000,
    url: () => 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: ({ apiKey }) => ({ 'x-goog-api-key': apiKey ?? '' }),
    parse: (body) => {
        const models =
            (
                body as {
                    models?: Array<{
                        name: string;
                        supportedGenerationMethods?: string[];
                    }>;
                }
            )?.models ?? [];
        return models
            .filter((m) => m.name?.includes('gemini'))
            .map((m) => {
                // The API normally returns `models/<id>`, but guard against a
                // bare id or a missing prefix so an unexpected response shape
                // doesn't throw and crash the whole listing.
                const parts = m.name?.split('/') ?? [];
                const modelId =
                    parts.length > 1 ? parts[1] : (parts[0] ?? m.name);
                return catalogWithReasoning(modelId, formatModelName(modelId));
            });
    },
};

export function googleGeminiModelListing(
    providerId: string,
): ModelListing | null {
    return providerId === 'google_gemini' ? httpListing : null;
}
