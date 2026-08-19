// The formatter now runs through the ONE primitive (LLM.run) — mock it at that
// boundary and assert on the `user` prompt it receives (prompt composition is
// what this suite verifies; the model policy is LLM.run's own tested concern).
const mockRun = jest.fn();
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: (...args: any[]) => mockRun(...args) },
}));

import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

describe('formatSuggestionContent — prompt composition', () => {
    const suggestion = {
        suggestionContent: 'WHAT: x. WHY: y. HOW: z.',
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: 'src/foo.ts',
        language: 'TypeScript',
    };

    beforeEach(() => {
        mockRun.mockReset();
        // LLM.run returns the raw text (no schema) — the formatter parses it.
        mockRun.mockResolvedValue(
            '```json\n[{"index": 0, "suggestionContent": "ok"}]\n```',
        );
    });

    const captureLastPrompt = (): string => {
        const call = mockRun.mock.calls.at(-1);
        return call?.[0]?.user ?? '';
    };

    describe('customWritingGuidelines', () => {
        it('injects the team guidelines verbatim into the prompt', async () => {
            await formatSuggestionContent([suggestion], {
                customWritingGuidelines:
                    'Always begin findings with a verb in the imperative.',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toContain(
                'Additional writing guidelines from the team:',
            );
            expect(prompt).toContain(
                'Always begin findings with a verb in the imperative.',
            );
            expect(prompt).toContain(
                'The team has provided custom writing guidelines. Follow them — they take priority over the default rules above.',
            );
        });

        it('omits the guidelines block when no custom guidelines are provided', async () => {
            await formatSuggestionContent([suggestion], {});

            const prompt = captureLastPrompt();
            expect(prompt).not.toContain(
                'Additional writing guidelines from the team:',
            );
            expect(prompt).not.toContain(
                'The team has provided custom writing guidelines',
            );
        });
    });

    describe('languageResultPrompt (idioma do team)', () => {
        it('injects pt-BR positive instruction when languageResultPrompt is "pt-BR"', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'pt-BR',
            });

            const prompt = captureLastPrompt();
            // Display name "Brazilian Portuguese" or similar
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toMatch(/Portuguese/i);
            expect(prompt).toContain('Do not fall back to English.');
        });

        it('injects en-US instruction when languageResultPrompt is "en-US"', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'en-US',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toMatch(/English/i);
        });

        it('still emits a language directive for unusual locales (does not silently drop)', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'xx-YY',
            });

            const prompt = captureLastPrompt();
            // Intl.DisplayNames produces "xx (YY)" or similar; just verify the directive is present.
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toContain('Do not fall back to English.');
        });

        it('omits the language directive when no languageResultPrompt is provided', async () => {
            await formatSuggestionContent([suggestion], {});

            const prompt = captureLastPrompt();
            expect(prompt).not.toContain('IMPORTANT: Write all output in');
            expect(prompt).not.toContain('Do not fall back to English');
        });
    });

    describe('combined', () => {
        it('emits BOTH the custom guidelines block AND the language directive when both are set', async () => {
            await formatSuggestionContent([suggestion], {
                customWritingGuidelines: 'Use bullet points only.',
                languageResultPrompt: 'pt-BR',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toContain('Use bullet points only.');
            expect(prompt).toMatch(/Write all output in.*Portuguese/i);
        });
    });

    describe('short-circuits', () => {
        it('returns empty map and does NOT call the LLM when there are no suggestions', async () => {
            const result = await formatSuggestionContent([], {
                customWritingGuidelines: 'irrelevant',
            });

            expect(result.size).toBe(0);
            expect(mockRun).not.toHaveBeenCalled();
        });
    });
});
