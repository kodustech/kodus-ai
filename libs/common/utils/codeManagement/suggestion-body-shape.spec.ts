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
