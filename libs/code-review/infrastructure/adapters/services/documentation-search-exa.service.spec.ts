import { DocumentationSearchExaService } from './documentation-search-exa.service';

/**
 * The pure transforms around the Exa documentation search: they normalize the
 * planner's query tasks and defensively extract fields from an external API
 * response (which is untrusted shape). A regression here means duplicate/empty
 * searches go out, or a malformed Exa payload crashes the review instead of
 * degrading. The Exa client and cache are never touched by these methods.
 */
describe('DocumentationSearchExaService — pure query/response transforms', () => {
    const svc = new DocumentationSearchExaService(
        { get: () => undefined } as any,
        {} as any,
        {} as any,
    );
    const call = (m: string, ...args: any[]) => (svc as any)[m](...args);

    describe('normalizeQueryTasks', () => {
        it('skips tasks with an empty/whitespace package name or query', () => {
            const out = call('normalizeQueryTasks', [
                { packageName: 'react', query: 'hooks' },
                { packageName: '  ', query: 'x' },
                { packageName: 'vue', query: '   ' },
                { packageName: 'ok', query: '' },
            ]);
            expect(out).toEqual([{ packageName: 'react', query: 'hooks' }]);
        });

        it('de-duplicates case-insensitively by package + query, and trims', () => {
            const out = call('normalizeQueryTasks', [
                { packageName: ' React ', query: ' Hooks ' },
                { packageName: 'react', query: 'hooks' }, // dup after normalize
            ]);
            expect(out).toEqual([{ packageName: 'React', query: 'Hooks' }]);
        });

        it('tolerates a null/undefined task list', () => {
            expect(call('normalizeQueryTasks', undefined)).toEqual([]);
        });
    });

    describe('extractLanguageFromQuery', () => {
        it('pulls the language out of a "Language: X." clause (case-insensitive)', () => {
            expect(call('extractLanguageFromQuery', 'language: TypeScript. do X')).toBe(
                'TypeScript',
            );
        });

        it('returns "Unspecified" when there is no language clause', () => {
            expect(call('extractLanguageFromQuery', 'just a query')).toBe(
                'Unspecified',
            );
        });
    });

    describe('buildSnippet', () => {
        it('collapses whitespace and trims the extract', () => {
            expect(call('buildSnippet', '  a   b\n\tc  ', 'q')).toBe('a b c');
        });

        it('returns a query-labelled fallback when there is no extract', () => {
            expect(call('buildSnippet', '', 'my query')).toBe(
                'No extract was returned by Exa for query: my query',
            );
        });
    });

    describe('extractCitations — defensive against a malformed payload', () => {
        it('returns [] when citations are absent or not an array', () => {
            expect(call('extractCitations', {})).toEqual([]);
            expect(call('extractCitations', { citations: 'nope' })).toEqual([]);
        });

        it('keeps only object entries and coerces non-string title/url to undefined', () => {
            const out = call('extractCitations', {
                citations: [
                    { title: 'T', url: 'http://x' },
                    null,
                    'string-entry',
                    { title: 42, url: 99 },
                ],
            });
            expect(out).toEqual([
                { title: 'T', url: 'http://x' },
                { title: undefined, url: undefined },
            ]);
        });
    });

    describe('extractResults — defensive against a malformed payload', () => {
        it('returns [] when results are not an array', () => {
            expect(call('extractResults', { results: null })).toEqual([]);
        });

        it('maps title/url/text and drops non-object entries', () => {
            const out = call('extractResults', {
                results: [{ title: 'T', url: 'u', text: 'body' }, 7],
            });
            expect(out).toEqual([{ title: 'T', url: 'u', text: 'body' }]);
        });
    });

    describe('buildRawSearchContent', () => {
        it('returns an empty string when the response has neither citations nor results', () => {
            expect(call('buildRawSearchContent', {})).toBe('');
        });

        it('renders a Citations and a Results section when present', () => {
            const out = call('buildRawSearchContent', {
                citations: [{ title: 'Doc', url: 'http://d' }],
                results: [{ title: 'R', url: 'http://r', text: 'x   y' }],
            });
            expect(out).toContain('Citations:');
            expect(out).toContain('1. Doc - http://d');
            expect(out).toContain('Results:');
            expect(out).toContain('Excerpt: x y'); // whitespace collapsed
        });
    });
});
