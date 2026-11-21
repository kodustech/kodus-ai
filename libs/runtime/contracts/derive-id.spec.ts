import { canonicalJson, deriveId, insertionOrderJson, nulJoinedHex } from './derive-id';

describe('derive-id', () => {
    it('keeps apart two inputs whose NUL-joined text is the same', () => {
        expect(nulJoinedHex(['a\0b', 'c'])).toBe(nulJoinedHex(['a', 'b\0c']));
        expect(deriveId('ns', ['a\0b', 'c'])).not.toBe(deriveId('ns', ['a', 'b\0c']));
        expect(deriveId('ns', ['ab', 'c'])).not.toBe(deriveId('nsa', ['b', 'c']));
    });

    it('cuts a new id to the length asked', () => {
        expect(deriveId('ns', ['x'], 24)).toHaveLength(24);
    });

    it('encodes the same value with its keys in another order the same, and drops undefined members', () => {
        expect(canonicalJson({ b: 1, a: { d: undefined, c: [2] } })).toBe(canonicalJson({ a: { c: [2] }, b: 1 }));
        expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('keeps insertion order in the named non-canonical variant', () => {
        expect(insertionOrderJson({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
        expect(insertionOrderJson([undefined])).not.toBe(canonicalJson([undefined]));
    });
});
