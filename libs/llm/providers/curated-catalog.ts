import { REGISTRY } from './kernel/registry';

/**
 * Whether a provider's model catalog is CURATED / non-exhaustive rather than a
 * guaranteed-complete live enumeration — so a model missing from it is NOT proof
 * the model is invalid, and callers must not treat a miss as a hard mismatch/
 * failure. Two shapes qualify:
 *  - `kind: 'static'` — a hand-curated catalog (e.g. Vertex), never fetched live.
 *  - `kind: 'http'` WITH `fallbackModels` — a listing that tries live but can
 *    silently serve its curated subset when the live call can't run (e.g. Bedrock
 *    with IAM-only creds / no bearer token / a failed fetch). Same non-exhaustive
 *    semantics as static, so it gets the same treatment.
 * A plain `http` listing without a fallback (e.g. openai_compatible) is exhaustive
 * when it succeeds, so it is NOT curated.
 *
 * Registry-driven, so a newly added curated provider is covered automatically —
 * no second place to edit. Resolved per call (no import-order coupling on an
 * eagerly-built set), and accepts a bare provider id (module id or alias).
 */
export function isCuratedCatalogProvider(providerId: string): boolean {
    if (!REGISTRY.has(providerId)) {
        return false;
    }
    const listing = REGISTRY.get(providerId).modelListing?.(providerId);
    return (
        listing?.kind === 'static' ||
        (listing?.kind === 'http' && !!listing.fallbackModels?.length)
    );
}
