/**
 * Regression tests for the bot-comment filter inside
 * `CommentAnalysisService.processComments`. This filter is what stops
 * the rule-generator LLM from learning from Kody's own past reviews of
 * the same repository — a self-feedback loop that surfaced on
 * 2026-05-20 when bitbucket onboarding kept producing the same
 * generated rule run after run because Kody's prior bitbucket
 * suggestions were leaking through the filter.
 *
 * Two visible signatures across providers, both have to be matched:
 *   - `kody-codereview`    (github / gitlab / azure / forgejo)
 *   - `kody|code-review`   (bitbucket — uses a visible chip because
 *                           bitbucket's Atlassian Markdown escapes
 *                           raw HTML comments, so the HTML-comment
 *                           marker the other providers use is
 *                           rendered as literal text on bitbucket
 *                           and is unusable as a hidden marker)
 *
 * Pre-fix the filter only knew about the first form; bitbucket
 * comments slipped through.
 */
import { CommentAnalysisService } from '../commentAnalysis.service';

function makeService() {
    // processComments is a pure sync transform that never touches the
    // injected services — safe to wire with nulls and avoid mocking
    // out the whole DI graph.
    return new CommentAnalysisService(
        null as any,
        null as any,
        null as any,
    );
}

function longBody(prefix: string): string {
    // The downstream length filter drops anything shorter than 100
    // chars. Use a long-enough suffix so the only thing that can drop
    // these fixtures is the bot filter under test.
    return `${prefix}\n${'x'.repeat(200)}`;
}

describe('CommentAnalysisService.processComments — bot-comment filter', () => {
    it('drops bitbucket Kody suggestions (kody|code-review chip)', () => {
        const svc = makeService();

        const out = svc.processComments([
            {
                pr: { pull_number: 1, repository: { language: 'typescript' } },
                generalComments: [
                    {
                        id: 'human-1',
                        body: longBody('Looks good overall, ship it.'),
                        user: { id: 'u1', type: 'user' },
                    },
                    {
                        id: 'kody-bb-1',
                        body: longBody(
                            '`kody|code-review` `kody_rules` `severity-level|high`\n\nForbidden temporary marker TODO_REMOVE_ME appears in src/legacy/cleanup.ts',
                        ),
                        user: { id: 'kody', type: 'user' },
                    },
                ],
                reviewComments: [],
                files: [{ filename: 'src/legacy/cleanup.ts' }],
            },
        ]);

        // processComments returns a flat array of surviving comments
        // (see the `.flatMap((pr) => pr.comments)` near the end of the
        // method). Map to bodies for the assertions.
        const allBodies = (out ?? []).map((c: any) => String(c?.body ?? ''));
        expect(allBodies.some((b) => b.includes('Looks good overall'))).toBe(
            true,
        );
        expect(
            allBodies.some((b) => b.includes('kody|code-review')),
        ).toBe(false);
    });

    it('drops github/gitlab/azure Kody comments (kody-codereview HTML marker)', () => {
        const svc = makeService();

        const out = svc.processComments([
            {
                pr: { pull_number: 1, repository: { language: 'typescript' } },
                generalComments: [
                    {
                        id: 'human-2',
                        body: longBody('Could you split the test fixture?'),
                        user: { id: 'u2', type: 'user' },
                    },
                    {
                        id: 'kody-gh-1',
                        body: longBody(
                            'Avoid forbidden marker TODO_REMOVE_ME here.\n\n<!-- kody-codereview -->&#8203;',
                        ),
                        user: { id: 'kody', type: 'user' },
                    },
                ],
                reviewComments: [],
                files: [{ filename: 'src/legacy/cleanup.ts' }],
            },
        ]);

        const allBodies = (out ?? []).map((c: any) => String(c?.body ?? ''));
        expect(allBodies.some((b) => b.includes('Could you split'))).toBe(
            true,
        );
        expect(
            allBodies.some((b) => b.includes('kody-codereview')),
        ).toBe(false);
    });

    it('still drops comments whose `user.type` is "bot" regardless of body', () => {
        const svc = makeService();

        const out = svc.processComments([
            {
                pr: { pull_number: 1, repository: { language: 'typescript' } },
                generalComments: [
                    {
                        id: 'dependabot-1',
                        body: longBody('Bumps dependency from 1.0 to 1.1.'),
                        user: { id: 'dependabot', type: 'bot' },
                    },
                    {
                        id: 'human-3',
                        body: longBody('Reviewer feedback: rename foo to bar.'),
                        user: { id: 'u3', type: 'user' },
                    },
                ],
                reviewComments: [],
                files: [{ filename: 'src/foo.ts' }],
            },
        ]);

        const allBodies = (out ?? []).map((c: any) => String(c?.body ?? ''));
        expect(allBodies.some((b) => b.includes('Reviewer feedback'))).toBe(
            true,
        );
        expect(allBodies.some((b) => b.includes('Bumps dependency'))).toBe(
            false,
        );
    });
});
