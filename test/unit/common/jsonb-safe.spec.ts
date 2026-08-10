import { sanitizeForJsonb } from '@libs/common/utils/jsonb-safe';

/**
 * The characters under test are built with String.fromCharCode instead of
 * being typed literally: a raw U+0000 in a source file is invisible in
 * diffs and review, and editors love to eat it.
 *
 * Every expectation below was checked against a real Postgres 16 before
 * being written — `SELECT '{"a":"x\u0000y"}'::jsonb` fails with
 * `unsupported Unicode escape sequence`, and the sanitised form passes.
 */
const NUL = String.fromCharCode(0);
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** What node-postgres ends up handing to Postgres. */
const asJsonText = (value: unknown) => JSON.stringify(value);

describe('sanitizeForJsonb', () => {
    describe('the characters Postgres jsonb rejects', () => {
        it('removes U+0000 from string values', () => {
            const out = sanitizeForJsonb({ a: `x${NUL}y` });

            expect(out).toEqual({ a: 'xy' });
            expect(asJsonText(out)).not.toContain('\\u0000');
        });

        it('removes U+0000 from object keys', () => {
            const out = sanitizeForJsonb({ [`k${NUL}ey`]: 'v' });

            expect(Object.keys(out)).toEqual(['key']);
            expect(asJsonText(out)).not.toContain('\\u0000');
        });

        it('replaces an unpaired high surrogate', () => {
            const out = sanitizeForJsonb({ a: `x${HIGH_SURROGATE}y` });

            expect(out).toEqual({ a: `x${REPLACEMENT}y` });
        });

        it('replaces an unpaired low surrogate', () => {
            const out = sanitizeForJsonb({ a: `x${LOW_SURROGATE}y` });

            expect(out).toEqual({ a: `x${REPLACEMENT}y` });
        });

        it('reaches into nested objects and arrays', () => {
            const out = sanitizeForJsonb({
                turns: [{ text: `hi${NUL}` }, { text: 'ok' }],
                meta: { nested: { deep: `a${HIGH_SURROGATE}` } },
            });

            expect(out).toEqual({
                turns: [{ text: 'hi' }, { text: 'ok' }],
                meta: { nested: { deep: `a${REPLACEMENT}` } },
            });
        });
    });

    describe('what it must NOT touch', () => {
        it('keeps a literal backslash-u-0000 sequence intact', () => {
            // This is six ordinary characters, not a NUL. Postgres stores it
            // happily as text, so rewriting it would corrupt real data —
            // which is what a regex over the serialised JSON would do.
            const literal = 'C:\\u0000\\path';

            expect(sanitizeForJsonb({ a: literal })).toEqual({ a: literal });
        });

        it('keeps well-formed surrogate pairs (emoji) intact', () => {
            const emoji = 'ship it 🚀';

            expect(sanitizeForJsonb({ a: emoji })).toEqual({ a: emoji });
        });

        it('leaves non-string primitives alone', () => {
            const input = { n: 1, b: true, z: null, u: undefined };

            expect(sanitizeForJsonb(input)).toEqual(input);
        });

        it('does not mutate the input', () => {
            const input = { a: `x${NUL}y` };

            sanitizeForJsonb(input);

            expect(input.a).toBe(`x${NUL}y`);
        });
    });

    describe('depth ceiling', () => {
        it('drops the subtree past the limit instead of throwing', () => {
            let deep: Record<string, unknown> = { text: `end${NUL}` };
            for (let i = 0; i < 200; i++) {
                deep = { nested: deep };
            }

            expect(() => sanitizeForJsonb(deep)).not.toThrow();
            expect(asJsonText(sanitizeForJsonb(deep))).not.toContain('\\u0000');
        });
    });

    describe('the trap this replaces', () => {
        it('shows why sanitising after JSON.stringify is a no-op', () => {
            const raw = { a: `x${NUL}y` };

            // The pattern used elsewhere in the codebase: stringify first,
            // then strip U+0000. By then there is no U+0000 left to strip —
            // stringify turned it into the text \u0000.
            const stringifiedThenStripped = JSON.stringify(raw).replace(
                new RegExp(NUL, 'g'),
                '',
            );
            expect(stringifiedThenStripped).toContain('\\u0000');

            // Sanitising the object first is what actually removes it.
            expect(asJsonText(sanitizeForJsonb(raw))).not.toContain('\\u0000');
        });
    });
});
