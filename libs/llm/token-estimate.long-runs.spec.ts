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
// Real clocks: retried on a starved machine (a parallel run of the whole
// suite), as the other wall-clock specs are.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

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

    it('encodes a run of exactly the limit, and estimates one character past it', () => {
        const atLimit = `a ${'z'.repeat(MAX_ENCODED_RUN_CHARS)} b`;
        expect(fresh(atLimit)).toBe(exact(atLimit));
        const run = 'z'.repeat(MAX_ENCODED_RUN_CHARS + 1);
        expect(fresh(`a ${run} b`)).toBe(
            exact('a ') +
                Math.ceil(run.length / FALLBACK_CHARS_PER_TOKEN) +
                exact(' b'),
        );
    });

    it('never counts a long run without spaces in a non-Latin script below one token per character', () => {
        // Chinese is written without spaces: about 1-1.5 chars per token.
        const run = '漢字仮名交じり文'.repeat(300); // 2,400 chars, no space
        const tokens = fresh(run);
        expect(tokens).toBeGreaterThanOrEqual(run.length);
        // And still fast on a long one.
        const started = Date.now();
        fresh('中'.repeat(100_000));
        expect(Date.now() - started).toBeLessThan(500);
    });

    it.each([
        ['spaces', ' '],
        ['newlines', '\n'],
        ['tabs', '\t'],
        ['mixed whitespace', ' \n'],
    ])('answers fast on a long run of %s', (_l, unit) => {
        // A degenerate model reply padded with whitespace, or a tool
        // result with it: one pre-token piece, quadratic in tiktoken.
        const text = `start${unit.repeat(80_000 / unit.length)}end`;
        const started = Date.now();
        const tokens = fresh(text);
        expect(Date.now() - started).toBeLessThan(500);
        expect(tokens).toBeGreaterThanOrEqual(exact('start') + exact('end'));
    });

    it.each([
        ['space and U+2000', ' \u2000'],
        ['no-break spaces', '\u00a0\u202f'],
        ['ideographic space and newline', '\u3000\n'],
    ])('answers fast on a long whitespace run mixing %s', (_l, unit) => {
        // Every Unicode space tiktoken's \s splits on belongs to the run:
        // one missing would restart it at every step.
        const text = unit.repeat(40_000);
        const started = Date.now();
        fresh(text);
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('encodes a whitespace run of exactly the limit, and estimates one past it', () => {
        const atLimit = `a${' '.repeat(MAX_ENCODED_RUN_CHARS)}b`;
        expect(fresh(atLimit)).toBe(exact(atLimit));
        const run = ' '.repeat(MAX_ENCODED_RUN_CHARS + 1);
        expect(fresh(`a${run}b`)).toBe(
            exact('a') +
                Math.ceil(run.length / FALLBACK_CHARS_PER_TOKEN) +
                exact('b'),
        );
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
