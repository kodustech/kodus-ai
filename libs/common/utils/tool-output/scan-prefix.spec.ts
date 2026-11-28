import { cutAt, scanPrefix } from './scan-prefix';

describe('scanPrefix', () => {
    it('returns short text whole', () => {
        expect(scanPrefix('a\nb', 10)).toEqual({ text: 'a\nb', unread: 0 });
    });

    it('cuts at the last line end inside the limit and counts the rest', () => {
        expect(scanPrefix('aaa\nbbb\nccc', 9)).toEqual({ text: 'aaa\nbbb', unread: 4 });
    });

    it('never leaves half of an emoji when a line has no end to stop at', () => {
        // 'ab' then 😀 (two UTF-16 units) across a limit of 3.
        expect(scanPrefix('ab😀cd', 3)).toEqual({ text: 'ab', unread: 4 });
    });
});

describe('cutAt', () => {
    it('steps back off a high surrogate', () => {
        expect(cutAt('ab😀', 3)).toBe('ab');
    });

    it('keeps a whole emoji that fits', () => {
        expect(cutAt('ab😀c', 4)).toBe('ab😀');
    });
});
