import { truncateKeepingSurrogatePairs } from './truncate-text';

describe('truncateKeepingSurrogatePairs', () => {
    it('keeps text within the limit as it is', () => {
        expect(truncateKeepingSurrogatePairs('abc', 3)).toBe('abc');
    });

    it('cuts at the limit', () => {
        expect(truncateKeepingSurrogatePairs('abcdef', 4)).toBe('abcd');
    });

    it('never ends on half of an emoji', () => {
        // '🔥' is two UTF-16 units: a cut after its first one steps back.
        expect(truncateKeepingSurrogatePairs('ab🔥cd', 3)).toBe('ab');
        expect(truncateKeepingSurrogatePairs('ab🔥cd', 4)).toBe('ab🔥');
    });
});
