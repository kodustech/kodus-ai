import {
    buildDedupPrompt,
    buildTiebreakPrompt,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';

/**
 * Every prompt reached through `withStructuredOutputFallback` can end up
 * being sent with `response_format: { type: 'json_object' }` — that is
 * what the retry does when an upstream rejects `json_schema`, and
 * `@ai-sdk/openai-compatible` maps `supportsStructuredOutputs: false` to
 * exactly that body.
 *
 * OpenAI then rejects the whole request unless one of the messages
 * contains the word "json":
 *
 *   400 Prompt must contain the word 'json' in some form to use
 *       'response_format' of type 'json_object'
 *
 * The SDK injects nothing on that path, so the word has to be in the
 * prompt. These assertions look trivial; they exist because the failure
 * only shows up against one provider, on the retry path, in production.
 */
const mentionsJson = (prompt: string) => /json/i.test(prompt);

const suggestion = (overrides: Record<string, unknown> = {}) => ({
    relevantFile: 'src/a.ts',
    relevantLinesStart: 1,
    relevantLinesEnd: 2,
    label: 'bug',
    severity: 'high',
    oneSentenceSummary: 'null deref',
    suggestionContent: 'guard the access',
    existingCode: 'a.b',
    improvedCode: 'a?.b',
    ...overrides,
});

describe('prompts that can be sent with response_format json_object', () => {
    it('buildDedupPrompt names JSON', () => {
        const prompt = buildDedupPrompt(
            [suggestion(), suggestion({ relevantFile: 'src/b.ts' })] as never,
            (s) => s ?? 'medium',
        );

        expect(mentionsJson(prompt)).toBe(true);
    });

    it('buildTiebreakPrompt names JSON', () => {
        const prompt = buildTiebreakPrompt(
            suggestion() as never,
            suggestion({ oneSentenceSummary: 'other bug' }) as never,
        );

        expect(mentionsJson(prompt)).toBe(true);
    });

    it('keeps the instruction inside the prompt, not only in a comment', () => {
        // The regression this guards: dedup-prompt.ts already contained the
        // string "JSON" twice before this fix — both times in source
        // comments, neither in anything sent to the model.
        const prompt = buildTiebreakPrompt(
            suggestion() as never,
            suggestion() as never,
        );

        expect(prompt).toContain('JSON object');
    });
});
