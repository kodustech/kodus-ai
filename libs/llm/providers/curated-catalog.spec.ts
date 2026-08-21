import { isCuratedCatalogProvider } from './index';

// Real registry (provider modules self-register via the barrel side-effect).
describe('isCuratedCatalogProvider', () => {
    it('true for providers with a static (curated) modelListing', () => {
        // Bedrock and Vertex list from a curated static catalog, not a live fetch.
        expect(isCuratedCatalogProvider('amazon_bedrock')).toBe(true);
        expect(isCuratedCatalogProvider('google_vertex')).toBe(true);
    });

    it('false for an unregistered / unknown provider id', () => {
        expect(isCuratedCatalogProvider('not-a-provider')).toBe(false);
        expect(isCuratedCatalogProvider('')).toBe(false);
    });
});
