/**
 * token-estimator unit tests — tokenizer-backed counting (issue #1574).
 *
 * The whole point of the fix is that dense code does NOT tokenize at the old
 * flat 4-chars/token rate. These tests pin the two properties the compressor
 * relies on: (1) counts are non-trivial and (2) dense code counts materially
 * higher than chars/4 (i.e. the estimate no longer under-counts).
 */
import {
    estimateOverheadTokens,
    estimateTextTokens,
    estimateValueTokens,
} from './token-estimator';

describe('estimateTextTokens', () => {
    it('returns 0 for empty input', () => {
        expect(estimateTextTokens('')).toBe(0);
    });

    it('counts dense code well above the old flat chars/4 estimate', () => {
        // i18n-ish dense JS: the failure mode from the issue (~2.6–2.8 chars/tok).
        const dense = `const t = useTranslation();\nreturn t("some.very.deep.i18n.key.path.here");\n`.repeat(
            50,
        );
        const flat4 = Math.ceil(dense.length / 4);
        const real = estimateTextTokens(dense);
        // Real tokenizer must count MORE tokens than the flat-4 undercount.
        expect(real).toBeGreaterThan(flat4);
    });

    it('does not throw on special-token-like sequences in diffs', () => {
        expect(() =>
            estimateTextTokens('before <|endoftext|> after'),
        ).not.toThrow();
        expect(estimateTextTokens('before <|endoftext|> after')).toBeGreaterThan(
            0,
        );
    });
});

describe('estimateValueTokens', () => {
    it('serializes objects before counting', () => {
        expect(estimateValueTokens({ a: 'hello', b: 'world' })).toBeGreaterThan(
            0,
        );
    });

    it('returns 0 for null/undefined', () => {
        expect(estimateValueTokens(null)).toBe(0);
        expect(estimateValueTokens(undefined)).toBe(0);
    });
});

describe('estimateOverheadTokens', () => {
    it('sums the system prompt and every tool schema', () => {
        const system = 'You are a code reviewer. '.repeat(20);
        const tools = [
            { name: 'readFile', description: 'read', inputSchema: {} },
            { name: 'grep', description: 'search', inputSchema: {} },
        ];
        const total = estimateOverheadTokens(system, tools);
        const systemOnly = estimateOverheadTokens(system, []);
        expect(systemOnly).toBeGreaterThan(0);
        expect(total).toBeGreaterThan(systemOnly);
    });

    it('handles an undefined system prompt', () => {
        expect(estimateOverheadTokens(undefined, [])).toBe(0);
    });
});
