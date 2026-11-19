import { get_encoding } from 'tiktoken';

import {
    estimateTextTokens,
    FALLBACK_CHARS_PER_TOKEN,
    MAX_ENCODED_RUN_CHARS,
} from './token-estimate';

/**
 * Real tokenizer (the sibling spec mocks it). tiktoken is quadratic on one
 * long run without whitespace; the context compressor froze a worker for 88s
 * on such a run in prod (2026-11-19).
 */
describe('estimateTextTokens — long runs without whitespace', () => {
    const enc = get_encoding('o200k_base');
    const exact = (t: string) => enc.encode_ordinary(t).length;
    const fresh = (t: string) => estimateTextTokens(t, { cache: false });

    it('answers fast on a 100KB run without whitespace', () => {
        const run = 'x'.repeat(100_000);
        const started = Date.now();
        const tokens = fresh(`const a = "${run}";`);
        expect(Date.now() - started).toBeLessThan(500);
        expect(tokens).toBeGreaterThan(0);
    });

    it('answers fast on many long runs (a minified hex-ish bundle)', () => {
        const run = 'abcdef'.repeat(2_000); // 12KB, no separator
        const text = Array.from({ length: 25 }, () => run).join('\n');
        const started = Date.now();
        fresh(text);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('counts a long run by the fallback ratio and the rest exactly', () => {
        const before = 'export const blob = ';
        const run = 'q'.repeat(MAX_ENCODED_RUN_CHARS + 500);
        const after = '\nexport const next = 1;\n';
        expect(fresh(before + run + after)).toBe(
            exact(before) +
                Math.ceil(run.length / FALLBACK_CHARS_PER_TOKEN) +
                exact(after),
        );
    });

    it('encodes a run of exactly the limit as before', () => {
        const text = `a ${'z'.repeat(MAX_ENCODED_RUN_CHARS)} b`;
        expect(fresh(text)).toBe(exact(text));
    });

    it.each([
        [
            'short code',
            'export function add(a: number, b: number) { return a + b; }\n',
        ],
        [
            'a 100KB TypeScript file',
            Array.from(
                { length: 2_500 },
                (_, i) => `export const value${i} = compute(${i}, "x");`,
            ).join('\n'),
        ],
        [
            'a JSON with many short tokens',
            JSON.stringify(
                Array.from({ length: 3_000 }, (_, i) => ({
                    id: i,
                    n: `k${i}`,
                })),
                null,
                2,
            ),
        ],
    ])('counts %s exactly as tiktoken does', (_l, text) => {
        expect(fresh(text)).toBe(exact(text));
    });
});
