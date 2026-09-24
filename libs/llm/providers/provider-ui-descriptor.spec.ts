import {
    isCustomEndpoint,
    describeProviderId,
    describeAllProviderIds,
} from './provider-ui-descriptor';

/**
 * Mutation-killing tests for the deterministic UI-descriptor derivation.
 *
 * `labelForId`, `listingRequiresUserBaseUrl` and `listingIsAutoListable` are
 * module-private; they are exercised through their only public surface,
 * `describeProviderId`, which projects them onto the descriptor's `label`,
 * `requiresBaseUrl`, `autoListModels` and `listsModelsLive` fields.
 */

// A minimal ProviderModule stub. Only the fields the target methods read are
// populated; the rest are inert.
const makeModule = (overrides = {}): any => ({
    id: 'openai',
    label: 'OpenAI',
    doc: 'https://docs.example/openai',
    uiFields: [],
    // Default: no listing at all unless a test supplies one.
    modelListing: () => null,
    ...overrides,
});

// Listing factories (only the shape the descriptor inspects matters).
const httpListing = (extra = {}) => ({
    kind: 'http',
    url: () => 'https://x/models',
    headers: () => ({}),
    parse: () => [],
    ...extra,
});
const staticListing = () => ({ kind: 'static', models: [] });
const manualListing = () => ({ kind: 'manual' });

describe('isCustomEndpoint', () => {
    it('is true only when the id ends with the exact "_compatible" suffix', () => {
        expect(isCustomEndpoint('openai_compatible')).toBe(true);
        // Bare suffix still counts (endsWith).
        expect(isCustomEndpoint('_compatible')).toBe(true);
    });

    it('is false for ids that do not end with "_compatible"', () => {
        expect(isCustomEndpoint('openai')).toBe(false);
        expect(isCustomEndpoint('')).toBe(false);
        // Suffix present but not at the end.
        expect(isCustomEndpoint('_compatible_openai')).toBe(false);
        // Trailing extra char breaks the suffix.
        expect(isCustomEndpoint('openai_compatiblex')).toBe(false);
        // Case-sensitive: capital C does not match.
        expect(isCustomEndpoint('openai_Compatible')).toBe(false);
    });
});

describe('describeProviderId - label (labelForId)', () => {
    it('returns the module label verbatim when the id equals the module id', () => {
        const m = makeModule({ id: 'openai', label: 'OpenAI' });
        expect(describeProviderId(m, 'openai').label).toBe('OpenAI');
    });

    it('appends " Compatible" for a custom-endpoint alias', () => {
        const m = makeModule({ id: 'openai', label: 'OpenAI' });
        expect(describeProviderId(m, 'openai_compatible').label).toBe(
            'OpenAI Compatible',
        );
    });

    it('returns the plain module label for a non-custom alias that differs from the id', () => {
        // Distinct third branch: alias id, not equal to module.id, not custom.
        const m = makeModule({ id: 'openai', label: 'OpenAI' });
        expect(describeProviderId(m, 'openai-mini').label).toBe('OpenAI');
    });
});

describe('describeProviderId - requiresApiKey (requiresField apiKey)', () => {
    it('is true when a required apiKey field is present', () => {
        const m = makeModule({
            uiFields: [{ key: 'apiKey', required: true }],
        });
        expect(describeProviderId(m, m.id).requiresApiKey).toBe(true);
    });

    it('is false when the apiKey field exists but is not required', () => {
        const m = makeModule({
            uiFields: [{ key: 'apiKey', required: false }],
        });
        expect(describeProviderId(m, m.id).requiresApiKey).toBe(false);
    });

    it('is false when a required field exists but under a different key', () => {
        const m = makeModule({
            uiFields: [{ key: 'baseURL', required: true }],
        });
        expect(describeProviderId(m, m.id).requiresApiKey).toBe(false);
    });

    it('is false when uiFields is absent (?? [] default applies)', () => {
        const m = makeModule({ uiFields: undefined });
        expect(describeProviderId(m, m.id).requiresApiKey).toBe(false);
    });
});

describe('describeProviderId - requiresBaseUrl', () => {
    it('is true for a custom endpoint regardless of listing/fields', () => {
        // custom short-circuits the OR: no listing, no baseURL field.
        const m = makeModule({ id: 'openai', modelListing: () => null });
        expect(describeProviderId(m, 'openai_compatible').requiresBaseUrl).toBe(
            true,
        );
    });

    it('is true (non-custom) when an http listing requires a base URL with no default', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: true }),
        });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(true);
    });

    it('is false when the http listing requires a base URL but supplies a default', () => {
        const m = makeModule({
            modelListing: () =>
                httpListing({
                    requiresBaseURL: true,
                    defaultBaseURL: 'https://default/',
                }),
        });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(false);
    });

    it('is false when the http listing does not require a base URL', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(false);
    });

    it('is false for a static listing (not http)', () => {
        const m = makeModule({ modelListing: () => staticListing() });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(false);
    });

    it('is false when there is no listing and no baseURL field', () => {
        const m = makeModule({ modelListing: () => null });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(false);
    });

    it('is true (non-custom, no listing) when the module declares a required baseURL field', () => {
        const m = makeModule({
            modelListing: () => null,
            uiFields: [{ key: 'baseURL', required: true }],
        });
        expect(describeProviderId(m, m.id).requiresBaseUrl).toBe(true);
    });
});

describe('describeProviderId - autoListModels (listingIsAutoListable)', () => {
    it('is false for a custom endpoint even when its listing is static/listable', () => {
        const m = makeModule({ modelListing: () => staticListing() });
        expect(describeProviderId(m, 'openai_compatible').autoListModels).toBe(
            false,
        );
    });

    it('is true for a static listing', () => {
        const m = makeModule({ modelListing: () => staticListing() });
        expect(describeProviderId(m, m.id).autoListModels).toBe(true);
    });

    it('is true for an http listing that does not require a base URL', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(describeProviderId(m, m.id).autoListModels).toBe(true);
    });

    it('is true for an http listing that requires a base URL but has a default', () => {
        const m = makeModule({
            modelListing: () =>
                httpListing({
                    requiresBaseURL: true,
                    defaultBaseURL: 'https://default/',
                }),
        });
        expect(describeProviderId(m, m.id).autoListModels).toBe(true);
    });

    it('is false for an http listing that requires a base URL with no default', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: true }),
        });
        expect(describeProviderId(m, m.id).autoListModels).toBe(false);
    });

    it('is false for a manual listing', () => {
        const m = makeModule({ modelListing: () => manualListing() });
        expect(describeProviderId(m, m.id).autoListModels).toBe(false);
    });

    it('is false when there is no listing', () => {
        const m = makeModule({ modelListing: () => null });
        expect(describeProviderId(m, m.id).autoListModels).toBe(false);
    });
});

describe('describeProviderId - listsModelsLive', () => {
    it('is true for a non-custom http listing whose base URL resolves without the user', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(true);
    });

    it('is true for an http listing that requires a base URL but supplies a default', () => {
        const m = makeModule({
            modelListing: () =>
                httpListing({
                    requiresBaseURL: true,
                    defaultBaseURL: 'https://default/',
                }),
        });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(true);
    });

    it('is false for an http listing that requires a base URL with no default', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: true }),
        });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(false);
    });

    it('is false for a static listing (auto-listable but not live)', () => {
        const m = makeModule({ modelListing: () => staticListing() });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(false);
    });

    it('is false for a manual listing', () => {
        const m = makeModule({ modelListing: () => manualListing() });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(false);
    });

    it('is false when there is no listing', () => {
        const m = makeModule({ modelListing: () => null });
        expect(describeProviderId(m, m.id).listsModelsLive).toBe(false);
    });

    it('is false for a custom endpoint even with a resolvable http listing', () => {
        const m = makeModule({
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(
            describeProviderId(m, 'openai_compatible').listsModelsLive,
        ).toBe(false);
    });
});

describe('describeProviderId - doc passthrough and full shape', () => {
    it('carries the module doc onto the descriptor', () => {
        const m = makeModule({ doc: 'https://docs/x' });
        expect(describeProviderId(m, m.id).doc).toBe('https://docs/x');
    });

    it('doc is undefined when the module has none', () => {
        const m = makeModule({ doc: undefined });
        expect(describeProviderId(m, m.id).doc).toBeUndefined();
    });

    it('produces the exact descriptor for a native live-listing provider', () => {
        const m = makeModule({
            id: 'openai',
            label: 'OpenAI',
            doc: 'https://docs/openai',
            uiFields: [{ key: 'apiKey', required: true }],
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(describeProviderId(m, 'openai')).toEqual({
            id: 'openai',
            label: 'OpenAI',
            requiresApiKey: true,
            requiresBaseUrl: false,
            autoListModels: true,
            listsModelsLive: true,
            doc: 'https://docs/openai',
        });
    });

    it('produces the exact descriptor for a custom-endpoint alias', () => {
        const m = makeModule({
            id: 'openai',
            label: 'OpenAI',
            doc: 'https://docs/openai',
            uiFields: [{ key: 'apiKey', required: true }],
            // Even a resolvable http listing is ignored for custom endpoints.
            modelListing: () => httpListing({ requiresBaseURL: false }),
        });
        expect(describeProviderId(m, 'openai_compatible')).toEqual({
            id: 'openai_compatible',
            label: 'OpenAI Compatible',
            requiresApiKey: true,
            requiresBaseUrl: true,
            autoListModels: false,
            listsModelsLive: false,
            doc: 'https://docs/openai',
        });
    });

    it('passes the connectable id through to modelListing', () => {
        const seen = [];
        const m = makeModule({
            modelListing: (id) => {
                seen.push(id);
                return null;
            },
        });
        describeProviderId(m, 'openai_compatible');
        expect(seen).toEqual(['openai_compatible']);
    });

    it('treats a module with no modelListing method as having no listing', () => {
        const m = makeModule({ modelListing: undefined });
        const d = describeProviderId(m, m.id);
        expect(d.autoListModels).toBe(false);
        expect(d.listsModelsLive).toBe(false);
        expect(d.requiresBaseUrl).toBe(false);
    });
});

describe('describeAllProviderIds', () => {
    it('emits one descriptor per module id plus each alias, in order', () => {
        const modules = [
            makeModule({
                id: 'openai',
                label: 'OpenAI',
                aliases: ['openai_compatible'],
            }),
            makeModule({
                id: 'anthropic',
                label: 'Anthropic',
                doc: 'https://docs/anthropic',
                aliases: [],
            }),
        ];
        const out = describeAllProviderIds(modules);
        expect(out.map((d) => d.id)).toEqual([
            'openai',
            'openai_compatible',
            'anthropic',
        ]);
        expect(out.map((d) => d.label)).toEqual([
            'OpenAI',
            'OpenAI Compatible',
            'Anthropic',
        ]);
    });

    it('handles a module without an aliases array (emits only the module id)', () => {
        const modules = [makeModule({ id: 'solo', aliases: undefined })];
        const out = describeAllProviderIds(modules);
        expect(out.map((d) => d.id)).toEqual(['solo']);
    });

    it('returns an empty array for no modules', () => {
        expect(describeAllProviderIds([])).toEqual([]);
    });
});
