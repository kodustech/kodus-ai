/**
 * context-fit-planner unit tests — pure, zero LLM/IO.
 * Locks the token math + chunking that gate context-window fit.
 */
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';

import { estimateTextTokens } from '@libs/llm/token-estimate';

import {
    assertContextWindowFitsOverhead,
    chunkFilesByTokenBudget,
    estimateDiffTokens,
    estimatePromptTokens,
    extractHunkHeaders,
    normalizeFilenameForTier,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';

const file = (filename: string, patch: string): any => ({ filename, patch });

/** Text of at least `tokens` tokens: distinct words, which BPE cannot fold. */
const textOf = (tokens: number): string => {
    let text = '';
    let i = 0;
    while (estimateTextTokens(text) < tokens) text += ` w${i++}`;
    return text;
};

describe('context-fit-planner', () => {
    describe('estimateDiffTokens', () => {
        it('counts each diff with the tokenizer, not a character ratio', () => {
            // Line-numbered data runs well under 4 chars/token: a flat ratio
            // undercounted it by a third.
            const dense = Array.from(
                { length: 400 },
                (_, i) =>
                    `${i + 1} +  { code: 'P${i}', min: ${i % 80}, max: ${(i % 80) + 9} },`,
            ).join('\n');
            const files = [file('a.ts', dense), file('b.ts', 'const x = 1;')];
            expect(estimateDiffTokens(files)).toBe(
                estimateTextTokens(dense) + estimateTextTokens('const x = 1;'),
            );
            expect(estimateDiffTokens([files[0]])).toBeGreaterThan(
                dense.length / 4,
            );
        });
        it('prefers patchWithLinesStr over patch', () => {
            const withLines = textOf(50);
            const f: any = {
                filename: 'a.ts',
                patch: 'short',
                patchWithLinesStr: withLines,
            };
            expect(estimateDiffTokens([f])).toBe(estimateTextTokens(withLines));
        });
        it('recounts a file whose diff was replaced', () => {
            const f: any = file('a.ts', textOf(10));
            const before = estimateDiffTokens([f]);
            f.patch = textOf(40);
            expect(estimateDiffTokens([f])).toBeGreaterThan(before);
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
        it('throws when the overhead alone fills the window', () => {
            expect(() =>
                assertContextWindowFitsOverhead({
                    overheadTokens: 100,
                    contextWindow: 100,
                    modelName: 'tiny',
                }),
            ).toThrow(AgentContextWindowTooSmallError);
        });
        it('passes for a normal window', () => {
            expect(() =>
                assertContextWindowFitsOverhead({
                    overheadTokens: 8_000,
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
            const files = [
                file('a.ts', 'x'.repeat(4)),
                file('b.ts', 'y'.repeat(4)),
            ];
            expect(chunkFilesByTokenBudget(files, 100)).toHaveLength(1);
        });
        it('splits when the running total exceeds budget', () => {
            const files = [file('a.ts', textOf(10)), file('b.ts', textOf(10))];
            const budget = estimateDiffTokens([files[0]]) + 1;
            expect(chunkFilesByTokenBudget(files, budget)).toHaveLength(2);
        });
        it('gives an oversized file its own chunk', () => {
            const files = [
                file('a.ts', textOf(4)),
                file('big.ts', textOf(100)),
            ];
            const chunks = chunkFilesByTokenBudget(files, 12);
            expect(
                chunks.some(
                    (c) => c.length === 1 && c[0].filename === 'big.ts',
                ),
            ).toBe(true);
        });
    });

    describe('estimatePromptTokens', () => {
        it('adds the measured overhead to every diff, counted whole', () => {
            const f = file('a.ts', '@@ -1,1 +1,1 @@\n' + textOf(200));
            expect(estimatePromptTokens([f], 5_000)).toBe(
                estimateDiffTokens([f]) + 5_000,
            );
        });
    });
});
