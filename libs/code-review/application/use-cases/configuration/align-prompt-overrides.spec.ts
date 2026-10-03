import { alignPromptOverridesWithParent as alignWithReport } from './align-prompt-overrides';

const alignPromptOverridesWithParent = (incoming: any, parent: any) =>
    alignWithReport(incoming, parent).config;

const tiptap = (...paragraphs: string[]) =>
    JSON.stringify({
        type: 'doc',
        content: paragraphs.map((text) => ({
            type: 'paragraph',
            content: [{ type: 'text', text }],
        })),
    });

const parent = {
    v2PromptOverrides: {
        generation: { main: 'Line one.\nLine two.' },
        categories: { descriptions: { bug: 'Bug text', security: 'Sec text' } },
        severity: { flags: { critical: 'Crit text' } },
    },
};

describe('alignPromptOverridesWithParent', () => {
    it('replaces a prompt the editor re-serialised without changing its text with the parent value', () => {
        const out = alignPromptOverridesWithParent(
            {
                summary: { generatePRSummary: false },
                v2PromptOverrides: {
                    generation: { main: tiptap('Line one.', 'Line two.') },
                    categories: { descriptions: { bug: tiptap('Bug text') } },
                    severity: { flags: { critical: 'Crit text' } },
                },
            },
            parent,
        );

        expect(out.v2PromptOverrides.generation.main).toBe(
            'Line one.\nLine two.',
        );
        expect(out.v2PromptOverrides.categories.descriptions.bug).toBe(
            'Bug text',
        );
        expect(out.v2PromptOverrides.severity.flags.critical).toBe('Crit text');
        expect(out.summary).toEqual({ generatePRSummary: false });
    });

    it('matches the markdown default against the editor JSON with lists and bold', () => {
        const editorJson = JSON.stringify({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Intro line' }],
                },
                {
                    type: 'bulletList',
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [
                                        {
                                            type: 'text',
                                            marks: [{ type: 'bold' }],
                                            text: 'Bold part',
                                        },
                                        { type: 'text', text: ': rest.' },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const markdownParent = {
            v2PromptOverrides: {
                generation: { main: 'Intro line\n- **Bold part**: rest.' },
            },
        };

        const out = alignPromptOverridesWithParent(
            { v2PromptOverrides: { generation: { main: editorJson } } },
            markdownParent,
        );

        expect(out.v2PromptOverrides.generation.main).toBe(
            'Intro line\n- **Bold part**: rest.',
        );
    });

    it('keeps a real edit', () => {
        const edited = tiptap('Line one.', 'Line two, and be friendly.');
        const out = alignPromptOverridesWithParent(
            { v2PromptOverrides: { generation: { main: edited } } },
            parent,
        );

        expect(out.v2PromptOverrides.generation.main).toBe(edited);
    });

    it('leaves configs without prompt overrides untouched', () => {
        const incoming = { summary: { generatePRSummary: true } };

        expect(alignPromptOverridesWithParent(incoming, parent)).toEqual(
            incoming,
        );
    });

    it('does not invent a parent value the parent does not have', () => {
        const out = alignPromptOverridesWithParent(
            {
                v2PromptOverrides: {
                    categories: { descriptions: { performance: 'Perf' } },
                },
            },
            parent,
        );

        expect(out.v2PromptOverrides.categories.descriptions.performance).toBe(
            'Perf',
        );
    });
});

describe('alignPromptOverridesWithParent — report', () => {
    it('lists the prompts it replaced with the inherited text, for logging', () => {
        const { alignedPaths } = alignWithReport(
            {
                v2PromptOverrides: {
                    generation: { main: tiptap('Line one.', 'Line two.') },
                    categories: { descriptions: { bug: 'A real edit' } },
                },
            },
            parent,
        );

        expect(alignedPaths).toEqual(['generation.main']);
    });
});

describe('technical prompt edits survive saving', () => {
    it.each([
        ['Flag retries when count > 10.', 'Flag retries when count < 10.'],
        ['Check UserID.', 'Check userId.'],
    ])('preserves %s edited to %s', (inherited, edited) => {
        const value = tiptap(edited);
        const out = alignWithReport(
            { v2PromptOverrides: { severity: { flags: { high: value } } } },
            { v2PromptOverrides: { severity: { flags: { high: inherited } } } },
        );
        expect(out.config.v2PromptOverrides.severity.flags.high).toBe(value);
        expect(out.alignedPaths).toEqual([]);
    });
});
