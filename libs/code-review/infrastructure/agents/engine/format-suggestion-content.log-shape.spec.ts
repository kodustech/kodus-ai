jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

// The spy is created INSIDE the factory and read back through
// `requireMock`. A `const` declared above would be captured by the factory but
// not yet initialised when jest hoists the mock — the suite then fails to run,
// silently contributing zero tests to a green-looking total.
jest.mock('@libs/core/log/logger', () => {
    const warn = jest.fn();
    return {
        createLogger: () => ({
            log: jest.fn(),
            warn,
            error: jest.fn(),
            debug: jest.fn(),
        }),
        __warn: warn,
    };
});

import { LLM } from '@libs/llm/llm';
import { formatSuggestionContent } from './format-suggestion-content';

/**
 * What an unreadable response is allowed to say about itself.
 *
 * The character count alone could not separate a model that REFUSED from one
 * that answered in a shape the parser could not read — different problems with
 * different fixes, and the log could not tell an investigator which had
 * happened.
 *
 * What it must never carry is the text itself. That text is model output ABOUT
 * a customer's code, so a preview of it does not belong in a log store — the
 * same rule the NUL sanitiser follows when it reports field paths and never
 * values.
 */
const run = LLM.run as jest.Mock;
const warnSpy = (jest.requireMock('@libs/core/log/logger') as { __warn: jest.Mock }).__warn;

const scaffolded = () => [
    {
        suggestionContent: 'WHAT: problem 0\nWHY: impact 0\nHOW: fix 0',
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: 'src/0.ts',
        language: 'typescript',
    },
];

const lastParseWarn = () =>
    warnSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => /No JSON array/.test(String(a?.message)))
        .at(-1);

beforeEach(() => {
    run.mockReset();
    warnSpy.mockClear();
});

describe('formatSuggestionContent — reporting an unreadable response', () => {
    it('never puts the model text in the log', async () => {
        run.mockResolvedValue(
            'I cannot help with SECRET_CUSTOMER_IDENTIFIER here.',
        );

        await formatSuggestionContent(scaffolded(), {
            organizationId: 'org-9',
        });

        const warn = lastParseWarn();
        expect(warn).toBeDefined();
        expect(JSON.stringify(warn)).not.toContain(
            'SECRET_CUSTOMER_IDENTIFIER',
        );
    });

    it('separates a refusal from a shape the parser could not read', async () => {
        run.mockResolvedValue('I cannot help with that.');
        await formatSuggestionContent(scaffolded());
        const refusal = lastParseWarn()?.metadata;

        warnSpy.mockClear();
        run.mockResolvedValue('[{"wrong":"keys"}]');
        await formatSuggestionContent(scaffolded());
        const unreadable = lastParseWarn()?.metadata;

        expect(refusal.hasBracket).toBe(false);
        expect(unreadable.hasBracket).toBe(true);
    });

    it('says which tenant and how many suggestions were affected', async () => {
        // A count with no tenant cannot answer the first question anyone asks.
        run.mockResolvedValue('nope');

        await formatSuggestionContent(scaffolded(), {
            organizationId: 'org-9',
        });

        const meta = lastParseWarn()?.metadata;
        expect(meta.organizationId).toBe('org-9');
        expect(meta.suggestionCount).toBe(1);
        expect(meta.chars).toBe(4);
    });
});
