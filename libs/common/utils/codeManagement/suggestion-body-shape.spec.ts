import {
    shapeSuggestionBody,
    shapeSuggestionBodyWithReport,
} from './suggestion-body-shape';

describe('shapeSuggestionBody', () => {
    it('removes fenced code from the body', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws.\n\n```ts\nuser?.name\n```\n\nGuard it.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading name throws. Guard it.');
    });

    it('keeps inline code', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading `user.name` throws. Use `user?.name`.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading `user.name` throws. Use `user?.name`.');
    });

    it('drops a leading sentence that restates the title', () => {
        expect(
            shapeSuggestionBody({
                body: 'The user can be null when the account was deleted. Reading name throws a 500. Guard it.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toBe('Reading name throws a 500. Guard it.');
    });

    it('keeps the only sentence even when it restates the title', () => {
        expect(
            shapeSuggestionBody({
                body: 'The user can be null when the account was deleted.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toBe('The user can be null when the account was deleted.');
    });

    it('cuts the body to two sentences when asked', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws. The request fails. Guard it. Add a test.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('Reading name throws. The request fails.');
    });

    it('leaves length alone for teams with their own guidelines', () => {
        expect(
            shapeSuggestionBody({
                body: 'Reading name throws. The request fails. Guard it. Add a test.',
                title: 'User can be null',
                capSentences: false,
            }),
        ).toBe('Reading name throws. The request fails. Guard it. Add a test.');
    });

    it('does not split on a dot inside inline code or a file name', () => {
        expect(
            shapeSuggestionBody({
                body: '`config.retries` is ignored in client.ts. Use ?? instead. Add a test.',
                title: 'Zero falls through to the default',
                capSentences: true,
            }),
        ).toBe('`config.retries` is ignored in client.ts. Use ?? instead.');
    });

    it('does not end a sentence at e.g. or i.e. before inline code', () => {
        // Seen on 11 of 112 sent bodies: the cap cut "e.g. `fix`" after the
        // "e.g.", so the comment ended in a dangling lead-in.
        expect(
            shapeSuggestionBody({
                body: 'A negative offset turns into a 500. Clamp it the same way, e.g. `max(0, cursor.offset)`. Add a test.',
                title: 'Negative cursor offset is not clamped',
                capSentences: true,
            }),
        ).toBe(
            'A negative offset turns into a 500. Clamp it the same way, e.g. `max(0, cursor.offset)`.',
        );
        expect(
            shapeSuggestionBody({
                body: 'The flag is read twice. Read it once, i.e. `const on = isEnabled()`.',
                title: 'Feature check repeated per request',
                capSentences: true,
            }),
        ).toBe(
            'The flag is read twice. Read it once, i.e. `const on = isEnabled()`.',
        );
    });

    it('does not end a sentence at e.g. before a capital letter or a number', () => {
        expect(
            shapeSuggestionBody({
                body: 'The non-FIPS provider can win the tie. Give the providers distinct orders (e.g. FIPS 300, default 200) or fail loudly.',
                title: 'Providers share the top order',
                capSentences: true,
            }),
        ).toBe(
            'The non-FIPS provider can win the tie. Give the providers distinct orders (e.g. FIPS 300, default 200) or fail loudly.',
        );
    });

    it('returns the original when shaping would leave nothing', () => {
        expect(
            shapeSuggestionBody({
                body: '```ts\nuser?.name\n```',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toBe('```ts\nuser?.name\n```');
    });
});

describe('shapeSuggestionBodyWithReport', () => {
    it('reports what it changed, for logging', () => {
        expect(
            shapeSuggestionBodyWithReport({
                body: 'The user can be null when the account was deleted. Reading name throws.\n\n```ts\nuser?.name\n```\n\nGuard it. Add a test.',
                title: 'User can be null when the account was deleted',
                capSentences: true,
            }),
        ).toEqual({
            body: 'Reading name throws. Guard it.',
            removedFences: true,
            droppedTitleRepeat: true,
            capped: true,
        });
    });

    it('reports nothing changed for a body already in shape', () => {
        expect(
            shapeSuggestionBodyWithReport({
                body: 'Reading name throws. Guard it.',
                title: 'User can be null',
                capSentences: true,
            }),
        ).toEqual({
            body: 'Reading name throws. Guard it.',
            removedFences: false,
            droppedTitleRepeat: false,
            capped: false,
        });
    });
});
