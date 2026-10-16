import { buildFormatPrompt } from './format-prompt';

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

    it('caps the body at two sentences by default and forbids code blocks', () => {
        const prompt = buildFormatPrompt([suggestion]);

        expect(prompt).toMatch(/at most 2 sentences/i);
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
        expect(prompt).not.toMatch(/at most 2 sentences/i);
    });
});
