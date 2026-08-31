import { ReferenceDetectorService } from './reference-detector.service';

/**
 * The deterministic front of external-reference handling: a cheap heuristic gate
 * that decides whether the expensive LLM detection even runs, and the marker
 * extraction that feeds context loading. A false negative here means the review
 * silently loses referenced context; a control marker leaking through as a file
 * would try to load a non-file. Both are pinned.
 */
describe('ReferenceDetectorService — reference detection & marker extraction', () => {
    const svc = new ReferenceDetectorService();

    describe('hasLikelyExternalReferences', () => {
        it.each([
            ['@file: src/a.ts', '@file: prefix'],
            ['[[file:src/a.ts]]', '[[file:]] marker'],
            ['edit @utils.ts please', '@name.ext'],
            ['please refer to config.ts', '"refer to ...ext"'],
            ['check the setup in MY_CONSTANTS.ts', 'SCREAMING_CASE.ext'],
            ['update the README.md', 'well-known doc file'],
        ])('detects a likely reference in %j (%s)', (text) => {
            expect(svc.hasLikelyExternalReferences(text)).toBe(true);
        });

        it('returns false for prose with no reference-like token', () => {
            expect(svc.hasLikelyExternalReferences('just refactor the thing')).toBe(
                false,
            );
            expect(svc.hasLikelyExternalReferences('')).toBe(false);
        });
    });

    describe('extractMarkers', () => {
        it('collects the originalText of each provided reference', () => {
            const out = svc.extractMarkers('', [
                { originalText: '@ref.ts' } as any,
            ]);
            expect(out).toContain('@ref.ts');
        });

        it('extracts @file markers written in the prompt text', () => {
            expect(svc.extractMarkers('here is @src/utils.ts', [])).toContain(
                '@src/utils.ts',
            );
        });

        it('filters out Kodus control markers (@kody-sync / @kody-ignore)', () => {
            // both match the @-token regex but must NOT be treated as file refs
            expect(svc.extractMarkers('@kody-sync and @kody-ignore', [])).toEqual(
                [],
            );
        });

        it('extracts full MCP markers @mcp<app|tool>', () => {
            expect(svc.extractMarkers('call @mcp<github|search>', [])).toContain(
                '@mcp<github|search>',
            );
        });

        it('de-duplicates a marker that comes from BOTH a reference and the text', () => {
            const out = svc.extractMarkers('touching @dup.ts', [
                { originalText: '@dup.ts' } as any,
            ]);
            expect(out.filter((m) => m === '@dup.ts')).toHaveLength(1);
        });
    });
});
