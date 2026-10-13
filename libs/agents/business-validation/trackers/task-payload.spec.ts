import { htmlToText } from './task-payload';

describe('htmlToText', () => {
    it('keeps the text and the list layout of a tracker field', () => {
        expect(
            htmlToText(
                '<div>Let buyers pay.</div><ul><li>Total drops</li><li>Balance shown</li></ul>',
            ),
        ).toBe('Let buyers pay.\n- Total drops\n- Balance shown');
    });

    it('leaves no tag behind, whatever the field holds', () => {
        const text = htmlToText(
            '<div>Hi <iframe src="x"></iframe><scr<script>ipt>alert(1)</script> &lt;img onerror=x&gt;</div>',
        );
        expect(text).not.toMatch(/</);
        expect(text).toContain('Hi');
    });

    it('returns text without HTML as is, generics included', () => {
        expect(htmlToText('Returns Array<string> sorted')).toBe(
            'Returns Array<string> sorted',
        );
    });
});
