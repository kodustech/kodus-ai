import { buildFormatPrompt, parseFormatResponse } from './format-prompt';

const suggestion = {
    title: 'User can be null when the account was deleted',
    suggestionContent:
        'WHAT: The user can be null. WHY: Reading name throws. HOW: Guard it.',
    existingCode: 'user.name',
    improvedCode: 'user?.name',
    relevantFile: 'src/user.ts',
    language: 'typescript',
};

describe('buildFormatPrompt — body under a title', () => {
    it('gives the model each finding title so the body does not repeat it', () => {
        const prompt = buildFormatPrompt([suggestion]);

        expect(prompt).toContain(
            'Title: User can be null when the account was deleted',
        );
        expect(prompt).toMatch(/do not repeat the title/i);
    });

    it('caps the body at two sentences and 50 words by default and forbids code blocks', () => {
        const prompt = buildFormatPrompt([suggestion]);

        expect(prompt).toMatch(/at most 2 short sentences and 50 words/i);
        expect(prompt).toMatch(/no code blocks/i);
        expect(prompt).not.toContain('the code block already shows the fix');
    });

    it('lets team guidelines set length and tone, but keeps the shape rules after them', () => {
        const prompt = buildFormatPrompt([suggestion], {
            customWritingGuidelines: 'Explain in detail, like a mentor.',
        });

        const custom = prompt.indexOf('Explain in detail, like a mentor.');
        const shape = prompt.search(/These rules apply regardless/i);
        expect(custom).toBeGreaterThan(-1);
        expect(shape).toBeGreaterThan(custom);
        expect(prompt.slice(shape)).toMatch(/no code blocks/i);
        expect(prompt.slice(shape)).toMatch(/do not repeat the title/i);
        expect(prompt).not.toMatch(/at most 2 short sentences/i);
        expect(prompt.slice(shape)).toMatch(/no line numbers/i);
        expect(prompt.slice(shape)).toMatch(/sees the diff and nothing else/i);
    });

    // #2157: "keep every technical detail … line numbers" against a two
    // sentence cap made the model pack each sentence with parentheticals and
    // with lines and schema facts the reader cannot see in the pull request.
    it('asks for no line numbers and a pointer for what lies outside the diff', () => {
        const prompt = buildFormatPrompt([suggestion]);

        expect(prompt).not.toMatch(/keep every technical detail/i);
        expect(prompt).toMatch(/no line numbers/i);
        expect(prompt).toMatch(
            /sees the diff and nothing else.*name the file or symbol/i,
        );
    });

    // #2157: a title over the ceiling was cut by code, once inside inline
    // code. The formatter rewrites those titles; the others are not offered.
    it('asks for a new title only for the findings marked as too long', () => {
        const prompt = buildFormatPrompt([
            suggestion,
            { ...suggestion, title: 'x'.repeat(130), rewriteTitle: true },
        ]);

        const first = prompt.slice(
            prompt.indexOf('[0]'),
            prompt.indexOf('[1]'),
        );
        const second = prompt.slice(prompt.indexOf('[1]'));
        expect(first).toMatch(/^\[0\]\nTitle: User can be null/);
        expect(second).toMatch(
            /^\[1\]\nTitle \(too long, return a new "title"\): x+/,
        );
        expect(prompt).toMatch(/80 characters or fewer/);
    });

    it('does not mention title rewriting when no title is too long', () => {
        expect(buildFormatPrompt([suggestion])).not.toMatch(/"title"/);
    });
});

describe('parseFormatResponse — title', () => {
    it('reads a returned title and leaves it out when absent or not a string', () => {
        const { formatted } = parseFormatResponse(
            JSON.stringify([
                { index: 0, suggestionContent: 'Body.', title: 'New title' },
                { index: 1, suggestionContent: 'Body.' },
                { index: 2, suggestionContent: 'Body.', title: 7 },
            ]),
        );

        expect(formatted.get(0)?.title).toBe('New title');
        expect(formatted.get(1)).not.toHaveProperty('title');
        expect(formatted.get(2)).not.toHaveProperty('title');
    });
});
