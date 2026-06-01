/**
 * Providers that ship behind a "Beta" flag in the BYOK UI. Used to:
 *   - Show a Beta badge in the provider dropdown
 *   - Surface a heads-up in the credentials step
 *
 * A provider lands in Beta when it's newly integrated (Bedrock) or when
 * its auth path is meaningfully more complex than the single-key norm
 * (Vertex needs SA JSON + region). Remove a provider from this set once
 * it has enough production mileage.
 */
const BETA_PROVIDER_IDS = new Set<string>([
    "google_vertex",
    "amazon_bedrock",
]);

export function isBetaProvider(providerId: string | undefined): boolean {
    if (!providerId) return false;
    return BETA_PROVIDER_IDS.has(providerId);
}
