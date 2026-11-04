import { vertexModelListing } from './listing';

/**
 * Vertex retired the Gemini 2.5 family (gemini-2.5-pro / gemini-2.5-flash)
 * on 2026-10-20. The curated picker is a suggestion list, so offering a model
 * that now 404s sends users straight into a failing configuration.
 */
describe('vertexModelListing — curated catalog', () => {
    const listing = vertexModelListing('google_vertex')!;
    const ids = (listing as any).models.map((m: { id: string }) => m.id);

    it('is only served for google_vertex', () => {
        expect(vertexModelListing('openai')).toBeNull();
    });

    it('does not suggest retired Gemini 2.5 models', () => {
        expect(ids).not.toContain('gemini-2.5-pro');
        expect(ids).not.toContain('gemini-2.5-flash');
    });

    it('still lists the current Gemini and Claude families', () => {
        expect(ids).toContain('gemini-3.8-flash');
        expect(ids).toContain('claude-sonnet-5');
    });
});
