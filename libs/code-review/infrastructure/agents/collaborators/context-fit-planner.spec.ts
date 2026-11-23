/**
 * context-fit-planner unit tests — pure, zero LLM/IO.
 * Locks the token math + chunking that gate context-window fit.
 */
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';

import {
    CHARS_PER_TOKEN,
    assertContextWindowFitsOverhead,
    chunkFilesByTokenBudget,
    estimateDiffTokens,
    estimatePromptTokens,
    extractHunkHeaders,
    normalizeFilenameForTier,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';

const file = (filename: string, patch: string): any => ({ filename, patch });

describe('context-fit-planner', () => {
    describe('estimateDiffTokens', () => {
        it('sums ceil(diffChars / CHARS_PER_TOKEN) across files', () => {
            const files = [file('a.ts', 'x'.repeat(40)), file('b.ts', 'y'.repeat(4))];
            expect(estimateDiffTokens(files)).toBe(40 / CHARS_PER_TOKEN + 1);
        });
        it('prefers patchWithLinesStr over patch', () => {
            const f: any = { filename: 'a.ts', patch: 'short', patchWithLinesStr: 'x'.repeat(8) };
            expect(estimateDiffTokens([f])).toBe(2);
        });
    });

    describe('normalizeFilenameForTier', () => {
        it('strips leading slashes, normalizes backslashes, trims', () => {
            expect(normalizeFilenameForTier('a\\b.ts')).toBe('a/b.ts');
            expect(normalizeFilenameForTier('/x/y.ts')).toBe('x/y.ts');
            expect(normalizeFilenameForTier('  c.ts  ')).toBe('c.ts');
            expect(normalizeFilenameForTier(undefined)).toBe('');
        });
    });

    describe('hunk headers', () => {
        const diff = '@@ -1,2 +1,3 @@\n code\n@@ -10,1 +11,2 @@\n more';
        it('extracts each @@ header', () => {
            expect(extractHunkHeaders(diff)).toHaveLength(2);
        });
    });

    describe('assertContextWindowFitsOverhead', () => {
        it('throws when static overhead alone exceeds the window', () => {
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: { changedFiles: [] },
                    contextWindow: 100, // tiny — 62K-char overhead won't fit
                    modelName: 'tiny',
                }),
            ).toThrow(AgentContextWindowTooSmallError);
        });
        it('passes for a normal window', () => {
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: { changedFiles: [] },
                    contextWindow: 200_000,
                    modelName: 'big',
                }),
            ).not.toThrow();
        });
    });

    describe('chunkFilesByTokenBudget', () => {
        it('returns [[]] for no files', () => {
            expect(chunkFilesByTokenBudget([], 100)).toEqual([[]]);
        });
        it('packs files under budget into one chunk', () => {
            const files = [file('a.ts', 'x'.repeat(4)), file('b.ts', 'y'.repeat(4))];
            expect(chunkFilesByTokenBudget(files, 100)).toHaveLength(1);
        });
        it('splits when the running total exceeds budget', () => {
            const files = [
                file('a.ts', 'x'.repeat(40)), // 10 tokens
                file('b.ts', 'y'.repeat(40)), // 10 tokens
            ];
            // budget 12 → a fills chunk 1, b overflows → chunk 2
            expect(chunkFilesByTokenBudget(files, 12)).toHaveLength(2);
        });
        it('gives an oversized file its own chunk', () => {
            const files = [
                file('a.ts', 'x'.repeat(4)),
                file('big.ts', 'z'.repeat(400)), // 100 tokens > budget
            ];
            const chunks = chunkFilesByTokenBudget(files, 12);
            expect(chunks.some((c) => c.length === 1 && c[0].filename === 'big.ts')).toBe(true);
        });
    });

    describe('estimatePromptTokens', () => {
        it('counts an optional-tier file at its full diff, as the prompt sends it', () => {
            const f = file('a.ts', '@@ -1,1 +1,1 @@\n' + 'x'.repeat(4000));
            const tiered = {
                changedFiles: [f],
                fileTiers: new Map([['a.ts', 'optional' as const]]),
            };
            expect(estimatePromptTokens(tiered)).toBe(
                estimatePromptTokens({ changedFiles: [f] }),
            );
        });
    });
});
