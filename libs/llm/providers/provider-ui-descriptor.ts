/**
 * Single source for the UI-facing provider flags, derived from a registry
 * ProviderModule. Both the web provider list (`ProviderService` /
 * `GetByokProvidersUseCase`) project through this so there is ONE place that
 * decides "needs a key / needs a base URL / can list models" — adding a
 * validated provider under `libs/llm/providers` is all that's required.
 */
import type { ModelListing, ProviderModule } from './kernel/types';

export interface ProviderUiDescriptor {
    id: string;
    label: string;
    /** The connect form must collect an API key. */
    requiresApiKey: boolean;
    /** The user must supply a base URL (a custom endpoint), so it can't be
     *  defaulted for them. */
    requiresBaseUrl: boolean;
    /** The provider's models can be enumerated (dropdown) vs. typed by hand. */
    autoListModels: boolean;
    /** Provider documentation URL (hardcoded on the module). The UI links to this
     *  when a curated model has no Kodus-specific docsUrl. */
    doc?: string;
}

/** `*_compatible` ids are the custom-endpoint variants: the user points them at
 *  their OWN endpoint, so a base URL is mandatory and models can't be listed
 *  until that endpoint is known. */
export const isCustomEndpoint = (id: string): boolean =>
    id.endsWith('_compatible');

const labelForId = (module: ProviderModule, id: string): string => {
    if (id === module.id) return module.label;
    if (isCustomEndpoint(id)) return `${module.label} Compatible`;
    return module.label;
};

const listingRequiresUserBaseUrl = (listing: ModelListing | null): boolean =>
    !!listing &&
    listing.kind === 'http' &&
    !!listing.requiresBaseURL &&
    !listing.defaultBaseURL;

const listingIsAutoListable = (listing: ModelListing | null): boolean => {
    if (!listing) return false;
    if (listing.kind === 'static') return true;
    // An HTTP listing is enumerable when its base URL resolves without the user
    // (a default, or none required); a curated default like a proxy fallback
    // does not count for custom endpoints (handled by the caller).
    if (listing.kind === 'http')
        return !listing.requiresBaseURL || !!listing.defaultBaseURL;
    return false; // 'manual'
};

/** Derive the UI descriptor for one connectable id (a module id or an alias). */
export function describeProviderId(
    module: ProviderModule,
    id: string,
): ProviderUiDescriptor {
    const listing = module.modelListing?.(id) ?? null;
    const custom = isCustomEndpoint(id);
    const requiresField = (key: string): boolean =>
        (module.uiFields ?? []).some(
            (f) => f.key === key && f.required === true,
        );
    const requiresApiKey = requiresField('apiKey');
    return {
        id,
        label: labelForId(module, id),
        requiresApiKey,
        // Custom endpoints ALWAYS need the user's base URL; native providers only
        // when their listing requires one with no default to fall back on, OR when
        // the module declares a required `baseURL` field (e.g. Azure's per-resource
        // endpoint — not derivable from the listing, so the module states it).
        requiresBaseUrl:
            custom ||
            listingRequiresUserBaseUrl(listing) ||
            requiresField('baseURL'),
        // Custom endpoints can't be pre-listed (endpoint unknown until entered).
        // A curated BRAND (its module ships a `catalog`) is enumerable even when
        // its live listing is `manual` — the picker offers the curated models
        // (e.g. Z.ai/GLM, whose Anthropic-protocol module has no `/models` call).
        autoListModels:
            !custom &&
            (listingIsAutoListable(listing) ||
                (module.catalog?.length ?? 0) > 0),
        doc: module.doc,
    };
}

/** Descriptor for every connectable id (each module id + its aliases). */
export function describeAllProviderIds(
    modules: ProviderModule[],
): ProviderUiDescriptor[] {
    const out: ProviderUiDescriptor[] = [];
    for (const m of modules) {
        for (const id of [m.id, ...(m.aliases ?? [])]) {
            out.push(describeProviderId(m, id));
        }
    }
    return out;
}
