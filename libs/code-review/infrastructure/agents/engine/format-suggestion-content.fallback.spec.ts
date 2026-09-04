jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';
import { formatSuggestionContent } from './format-suggestion-content';

/**
 * The floor has to be WIRED to every way the model pass can fail.
 *
 * `stripReviewScaffolding` is covered on its own. What this pins is that no
 * path out of `formatSuggestionContent` can still hand the caller an empty map
 * while the suggestion carries WHAT/WHY/HOW — because the caller's loop over an
 * empty map leaves the raw content in place and it ships to the pull request.
 *
 * The five production causes in twelve hours were a suspended account (55), the
 * 90-second ceiling (25), a parse failure, a model id that does not exist and a
 * rate limit. They arrive here as exactly two shapes: a thrown error, or text
 * that does not parse. Both are covered below, plus the partial batch.
 */
const run = LLM.run as jest.Mock;

const scaffolded = (n = 1) =>
    Array.from({ length: n }, (_, i) => ({
        suggestionContent: `WHAT: problem ${i}\nWHY: impact ${i}\nHOW: fix ${i}`,
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: `src/${i}.ts`,
        language: 'typescript',
    }));

beforeEach(() => run.mockReset());

describe('formatSuggestionContent — nothing raw ships, whatever failed', () => {
    it('strips locally when the call times out (the 90s ceiling)', async () => {
        run.mockRejectedValue(new Error('This operation was aborted'));

        const out = await formatSuggestionContent(scaffolded(2));

        expect(out.size).toBe(2);
        expect(out.get(0)?.suggestionContent).not.toMatch(/WHAT:|WHY:|HOW:/);
        expect(out.get(0)?.suggestionContent).toContain('problem 0');
    });

    it('strips locally when the account is suspended', async () => {
        // The dominant cause: 55 of 86. No timeout change would have helped.
        run.mockRejectedValue(
            new Error(
                'Failed after 3 attempts. Last error: AI_APICallError: Your account is suspended due to insufficient balance, please recharge',
            ),
        );

        const out = await formatSuggestionContent(scaffolded(1));

        expect(out.get(0)?.suggestionContent).not.toMatch(/WHAT:/);
    });

    it('strips locally when the response has no JSON array', async () => {
        run.mockResolvedValue('I cannot help with that.');

        const out = await formatSuggestionContent(scaffolded(1));

        expect(out.get(0)?.suggestionContent).not.toMatch(/WHAT:/);
    });

    it('fills only the gaps of a partial batch, and the model wins', async () => {
        run.mockResolvedValue(
            JSON.stringify([
                { index: 0, suggestionContent: 'Model prose.', improvedCode: 'b' },
            ]),
        );

        const out = await formatSuggestionContent(scaffolded(2));

        expect(out.get(0)?.suggestionContent).toBe('Model prose.');
        expect(out.get(1)?.suggestionContent).not.toMatch(/WHAT:/);
        expect(out.get(1)?.suggestionContent).toContain('problem 1');
    });

    it('fills a gap the model hid behind an out-of-range index', async () => {
        // `parseFormatResponse` accepts any numeric index with no bounds check,
        // so this response makes `formatted.size` equal the batch size while
        // index 1 is still uncovered. A size-based gate skips the fallback and
        // suggestion 1 ships raw — the leak, reachable through its own fix.
        run.mockResolvedValue(
            JSON.stringify([
                { index: 0, suggestionContent: 'Model prose.', improvedCode: 'b' },
                { index: 5, suggestionContent: 'Nowhere.', improvedCode: 'b' },
            ]),
        );

        const out = await formatSuggestionContent(scaffolded(2));

        expect(out.get(1)?.suggestionContent).toBeDefined();
        expect(out.get(1)?.suggestionContent).not.toMatch(/WHAT:/);
        expect(out.get(1)?.suggestionContent).toContain('problem 1');
    });

    it('does not touch a suggestion that was already prose', async () => {
        // Kody Rules findings never carry the template. A fallback that
        // rewrote them would damage output that was fine.
        run.mockRejectedValue(new Error('boom'));

        const out = await formatSuggestionContent([
            {
                suggestionContent: 'The guard is missing on the comment path.',
                existingCode: '',
                improvedCode: '',
                relevantFile: 'a.ts',
                language: 'typescript',
            },
        ]);

        expect(out.size).toBe(0);
    });

    it('keeps the model pass as the preferred path', async () => {
        run.mockResolvedValue(
            JSON.stringify([
                { index: 0, suggestionContent: 'Polished prose.', improvedCode: 'b' },
            ]),
        );

        const out = await formatSuggestionContent(scaffolded(1));

        expect(out.get(0)?.suggestionContent).toBe('Polished prose.');
    });

    describe('what it asks the model for', () => {
        it('turns reasoning OFF — this pass rewrites prose, it decides nothing', async () => {
            // The models doing this work spent 69-100% of their output tokens
            // on reasoning, which is what put the call on the edge of its own
            // timeout: 25 of 86 failures in twelve hours of production.
            run.mockResolvedValue('[]');

            await formatSuggestionContent(scaffolded(1));

            expect(run.mock.calls[0][0].suppressReasoning).toBe(true);
        });

        it('gives the pass a 120s budget, not 90s', async () => {
            // 90s was chosen too close to the work: a batch of seven landed at
            // 89.1s. The fallback covers whatever this still fails to deliver,
            // so the budget buys headroom without risking the review.
            run.mockResolvedValue('[]');

            await formatSuggestionContent(scaffolded(1));

            expect(run.mock.calls[0][0].timeoutMs).toBe(120_000);
        });
    });

    describe('recovering the array from what the model put around it', () => {
        it.each([
            [
                'a note object before the array',
                '{"note":"here you go"} [{"index":0,"suggestionContent":"x"}]',
            ],
            [
                'a fenced block before the array',
                '```\n{"note":"a"}\n```\n[{"index":0,"suggestionContent":"x"}]',
            ],
            [
                'prose before the array',
                'Here you go:\n[{"index":0,"suggestionContent":"x"}]',
            ],
            [
                'a wrapper object',
                '{"suggestions":[{"index":0,"suggestionContent":"x"}]}',
            ],
        ])('recovers past %s', async (_label, out) => {
            // The envelope path reads the FIRST balanced JSON value, which is
            // the wrong one when something else leads. Losing these silently
            // sent the whole batch to the scaffolding fallback and gave up the
            // prose polish for nothing.
            run.mockResolvedValue(out);

            const result = await formatSuggestionContent(scaffolded(1));

            expect(result.get(0)?.suggestionContent).toBe('x');
        });

        it.each([
            ['plain prose', 'I cannot help with that.'],
            [
                'a refusal that happens to contain a bracket',
                'I cannot help [see policy].',
            ],
        ])('still refuses %s rather than inventing a success', async (_l, out) => {
            run.mockResolvedValue(out);

            const result = await formatSuggestionContent(scaffolded(1));

            // Falls back to the local strip, never to a fabricated empty parse.
            expect(result.get(0)?.suggestionContent).not.toMatch(/WHAT:/);
            expect(result.get(0)?.suggestionContent).toContain('problem 0');
        });
    });
});
