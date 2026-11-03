import {
    WRITING_POLICY_SWAPS,
    withClaudeWritingPolicy,
} from './one-problem-rule';
import {
    buildCategoryReviewPrompt,
    buildGeneralistReviewPrompt,
} from './review-prompt-blocks';

describe('withClaudeWritingPolicy', () => {
    // The swaps rewrite whole sentences; an edit to the wording in
    // review-prompt-blocks.ts would leave them matching nothing, silently.
    const prompts = [
        buildGeneralistReviewPrompt(),
        buildCategoryReviewPrompt('bug'),
        buildCategoryReviewPrompt('security'),
        buildCategoryReviewPrompt('performance'),
    ].join('\n');

    it.each(WRITING_POLICY_SWAPS.map(([from]) => [from]))(
        'finds the sentence it rewrites: %s',
        (from) => {
            expect(prompts).toContain(from);
        },
    );

    it('rewrites every one of them', () => {
        const rewritten = withClaudeWritingPolicy(prompts);
        for (const [from, to] of WRITING_POLICY_SWAPS) {
            expect(rewritten).not.toContain(from);
            expect(rewritten).toContain(to);
        }
    });
});
