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

describe('buildFormatPrompt — language under a custom agent voice (#2172)', () => {
    it('lets an agent voice name another language than the team default', () => {
        const prompt = buildFormatPrompt([suggestion], {
            customWritingGuidelines: 'Escreva em português do Brasil.',
            languageLabel: 'English',
            languageIsDefault: true,
        });

        expect(prompt).not.toContain('Do not fall back to English');
        expect(prompt).toContain(
            'Write in English unless the writing guidelines above name another language.',
        );
    });

    it('keeps the team language mandatory for the main review', () => {
        const prompt = buildFormatPrompt([suggestion], {
            languageLabel: 'English',
        });

        expect(prompt).toContain('IMPORTANT: Write all output in English.');
    });
});

describe('buildFormatPrompt — title in the agent voice', () => {
    it('leaves the title alone by default', () => {
        const prompt = buildFormatPrompt([suggestion]);
        expect(prompt).not.toContain('"title"');
    });

    it('asks for the title in the same language and voice when the voice is the agent own', () => {
        const prompt = buildFormatPrompt([suggestion], {
            customWritingGuidelines: 'Escreva em português.',
            rewriteTitle: true,
        });
        expect(prompt).toMatch(/rewrite the title in the same language/i);
        expect(prompt).toContain('"title"');
    });
});

describe('parseFormatResponse — title', () => {
    it('reads a rewritten title when present', () => {
        const { formatted } = parseFormatResponse(
            '[{"index":0,"suggestionContent":"Corpo.","title":"Título novo"}]',
        );
        expect(formatted.get(0)?.title).toBe('Título novo');
    });

    it('has no title when the model returns none', () => {
        const { formatted } = parseFormatResponse(
            '[{"index":0,"suggestionContent":"Body."}]',
        );
        expect(formatted.get(0)?.title).toBeUndefined();
    });
});
