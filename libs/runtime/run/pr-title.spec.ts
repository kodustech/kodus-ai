import { MAX_PR_TITLE_CHARS, displayPrTitle } from './pr-title';

// The PR title is untrusted display text: the Run keeps one clean line of it
// for the Runs list and the Run header, never anything that is interpreted.
describe('the PR title a Run keeps for display', () => {
    it('keeps an ordinary title as it is, trimmed', () => {
        expect(displayPrTitle('  fix(orders): coupon total rounds down  ')).toBe('fix(orders): coupon total rounds down');
    });

    it('reads a multi-line title as one line', () => {
        expect(displayPrTitle('first line\r\nsecond\tline\u2028third\nfourth')).toBe('first line second line third fourth');
    });

    it('removes control characters and the bidi controls that reorder what the reader sees', () => {
        // A line break among them (NEL) still separates words; the others are dropped.
        expect(displayPrTitle('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009bg')).toBe('abcde fg');
        expect(displayPrTitle('safe \u202Egnp.exe\u202C name\u2066x\u2069\u200E\u200F\u061C')).toBe('safe gnp.exe namex');
    });

    it('collapses runs of spaces left behind into one', () => {
        expect(displayPrTitle('a \u0000 \u0000  b')).toBe('a b');
    });

    it(`cuts at ${MAX_PR_TITLE_CHARS} characters without splitting one`, () => {
        expect(MAX_PR_TITLE_CHARS).toBe(256);
        expect(displayPrTitle('x'.repeat(1024))).toBe('x'.repeat(256));
        const emoji = '🚀'.repeat(300);
        const cut = displayPrTitle(emoji)!;
        expect(Array.from(cut)).toHaveLength(256);
        expect(cut).toBe('🚀'.repeat(256));
        // A space the cut leaves at the end is not kept.
        expect(displayPrTitle(`${'x'.repeat(255)} tail`)).toBe('x'.repeat(255));
    });

    it.each([undefined, null, '', '   ', '\n\t', '\u0000\u202E', 42, {}])('records no title when there is none to show (%j)', (raw) => {
        expect(displayPrTitle(raw)).toBeUndefined();
    });
});
