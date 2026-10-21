import {
    boundSuggestionTitle,
    fullSuggestionTitle,
    MAX_TITLE_CHARS,
    resolveSuggestionTitle,
} from './suggestion-title';

describe('resolveSuggestionTitle', () => {
    it('keeps a short summary as is', () => {
        expect(
            resolveSuggestionTitle({
                summary: 'Discount percentage applied as a fraction',
                body: 'irrelevant',
            }),
        ).toBe('Discount percentage applied as a fraction');
    });

    it('trims whitespace, collapses newlines and drops a trailing period', () => {
        expect(
            resolveSuggestionTitle({
                summary: '  Missing await on\n sendCancelEmail.  ',
                body: '',
            }),
        ).toBe('Missing await on sendCancelEmail');
    });

    it('falls back to the first sentence of the body when the summary is empty', () => {
        expect(
            resolveSuggestionTitle({
                summary: '   ',
                body: 'The join loop exits early on timeout. Remaining processes leak.',
            }),
        ).toBe('The join loop exits early on timeout');
    });

    it('does not split the fallback sentence on a dot inside inline code or a file name', () => {
        expect(
            resolveSuggestionTitle({
                summary: undefined,
                body: '`config.retries` is ignored in client.ts when set to 0. Use ?? instead of ||.',
            }),
        ).toBe('`config.retries` is ignored in client.ts when set to 0');
    });

    it(`cuts a long title at the last word boundary before ${MAX_TITLE_CHARS} chars and marks the cut`, () => {
        const summary =
            'The paginator slices the queryset with a negative start index when the cursor offset is negative, which Django rejects at runtime';
        const title = resolveSuggestionTitle({ summary, body: '' });

        expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
        expect(title.endsWith('…')).toBe(true);
        expect(summary.startsWith(title.slice(0, -1).trimEnd())).toBe(true);
        expect(title.slice(0, -1)).not.toMatch(/[\s,;:]$/);
    });

    it('does not cut inside an inline code span (#2157)', () => {
        const summary =
            '`Array.prototype.forEach` does not await its async callback, so `bulkReassign` returns `{ reassigned: 0, skipped: 0 }` before any row is reassigned';
        const title = resolveSuggestionTitle({ summary, body: '' });

        expect(title).toBe(
            '`Array.prototype.forEach` does not await its async callback, so `bulkReassign` returns…',
        );
        expect(title.split('`').length % 2).toBe(1);
    });

    it('closes the span when the title opens with code longer than the limit', () => {
        const summary = `\`${'a.b '.repeat(40)}\` is wrong`;
        const title = resolveSuggestionTitle({ summary, body: '' });

        expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
        expect(title.endsWith('`…')).toBe(true);
        expect(title.split('`').length % 2).toBe(1);
    });

    it('returns an empty string when there is nothing to build a title from', () => {
        expect(resolveSuggestionTitle({ summary: null, body: '' })).toBe('');
    });
});

describe('fullSuggestionTitle and boundSuggestionTitle', () => {
    const long =
        'The paginator slices the queryset with a negative start index when the cursor offset is negative, which Django rejects at runtime';

    it('resolves the title without cutting it, so a model can rewrite it first', () => {
        expect(fullSuggestionTitle({ summary: `  ${long}.  `, body: '' })).toBe(
            long,
        );
        expect(
            fullSuggestionTitle({ summary: '', body: 'First one. Second.' }),
        ).toBe('First one');
    });

    it('bounds what it is given and leaves a short title alone', () => {
        expect(boundSuggestionTitle('Short title.')).toBe('Short title');
        expect(boundSuggestionTitle(long)).toBe(
            resolveSuggestionTitle({ summary: long, body: '' }),
        );
        expect(boundSuggestionTitle(long).length).toBeLessThanOrEqual(
            MAX_TITLE_CHARS,
        );
        expect(boundSuggestionTitle(undefined)).toBe('');
    });
});
