import { REGISTRY } from './kernel/registry';

/**
 * Whether a provider lists its models from a CURATED STATIC catalog (declared in
 * the provider module's `modelListing`, `kind: 'static'`) rather than fetching
 * them live. A static catalog is NOT exhaustive, so a model missing from it is
 * NOT proof the model is invalid — callers must not treat a miss as a hard
 * mismatch/failure for these providers.
 *
 * Registry-driven, so a newly added curated provider is covered automatically —
 * no second place to edit. Resolved per call (no import-order coupling on an
 * eagerly-built set), and accepts a bare provider id (module id or alias).
 */
export function isCuratedCatalogProvider(providerId: string): boolean {
    if (!REGISTRY.has(providerId)) {
        return false;
    }
    return (
        REGISTRY.get(providerId).modelListing?.(providerId)?.kind === 'static'
    );
}
