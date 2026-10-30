/**
 * Tests for the reviewer denylist filter inside
 * `CommentAnalysisService.processComments` (issue #1497): the client can
 * exclude specific git users so Kody never learns Kody Rules from their
 * past review comments. Denylist semantics — an empty/undefined set keeps
 * everyone, and a comment whose author can't be identified is always kept.
 *
 * Cross-provider author identity: GitHub/Azure key the author on `user`,
 * GitLab on `author` (its discussion notes have no top-level `body`).
 */
import { CommentAnalysisService } from '../commentAnalysis.service';

function makeService() {
    // processComments is a pure sync transform that never touches the
    // injected services — safe to wire with nulls.
    return new CommentAnalysisService(null as any, null as any);
}

function longBody(prefix: string): string {
    // The downstream length filter drops anything under 100 chars.
    return `${prefix}\n${'x'.repeat(200)}`;
}

const bodies = (out: any) =>
    (out ?? []).map((c: any) => String(c?.body ?? ''));

describe('CommentAnalysisService.processComments — reviewer denylist', () => {
    it('drops comments from an excluded GitHub reviewer, keeps the rest', () => {
        const svc = makeService();

        const out = svc.processComments(
            [
                {
                    pr: { pull_number: 1, repository: { language: 'typescript' } },
                    generalComments: [
                        {
                            id: 'good-1',
                            body: longBody('Please extract this into a helper.'),
                            user: { id: 42, login: 'alice', type: 'user' },
                        },
                        {
                            id: 'noisy-1',
                            body: longBody('lgtm 👍 ship it whenever.'),
                            user: { id: 99, login: 'bob', type: 'user' },
                        },
                    ],
                    reviewComments: [],
                    files: [{ filename: 'src/foo.ts' }],
                },
            ],
            new Set(['99']),
        );

        expect(bodies(out).some((b) => b.includes('extract this'))).toBe(true);
        expect(bodies(out).some((b) => b.includes('lgtm'))).toBe(false);
    });

    it('keeps everyone when the denylist is empty or undefined', () => {
        const svc = makeService();
        const input = [
            {
                pr: { pull_number: 1, repository: { language: 'typescript' } },
                generalComments: [
                    {
                        id: 'c1',
                        body: longBody('Reviewer feedback: rename foo to bar.'),
                        user: { id: 99, login: 'bob', type: 'user' },
                    },
                ],
                reviewComments: [],
                files: [{ filename: 'src/foo.ts' }],
            },
        ];

        expect(bodies(svc.processComments(input as any)).length).toBe(1);
        expect(
            bodies(svc.processComments(input as any, new Set())).length,
        ).toBe(1);
    });

    it('excludes a GitLab reviewer via the notes-branch `author`', () => {
        const svc = makeService();

        const out = svc.processComments(
            [
                {
                    pr: { pull_number: 1, repository: { language: 'typescript' } },
                    // GitLab discussion comment: no top-level `body`, notes carry
                    // `author`. The notes branch must preserve `author` so the
                    // denylist can match it.
                    generalComments: [
                        {
                            notes: [
                                {
                                    id: 'gl-good',
                                    body: longBody('Consider a guard clause here.'),
                                    author: { id: 7, username: 'carol' },
                                },
                                {
                                    id: 'gl-bad',
                                    body: longBody('nit: whitespace, otherwise ok.'),
                                    author: { id: 8, username: 'dave' },
                                },
                            ],
                        },
                    ],
                    reviewComments: [],
                    files: [{ filename: 'src/foo.rb' }],
                },
            ],
            new Set(['8']),
        );

        expect(bodies(out).some((b) => b.includes('guard clause'))).toBe(true);
        expect(bodies(out).some((b) => b.includes('nit: whitespace'))).toBe(
            false,
        );
    });

    it('keeps comments whose author cannot be identified', () => {
        const svc = makeService();

        const out = svc.processComments(
            [
                {
                    pr: { pull_number: 1, repository: { language: 'typescript' } },
                    generalComments: [
                        {
                            id: 'anon-1',
                            body: longBody('Structural feedback with no author.'),
                            // no user / author
                        },
                    ],
                    reviewComments: [],
                    files: [{ filename: 'src/foo.ts' }],
                },
            ],
            new Set(['99']),
        );

        expect(bodies(out).some((b) => b.includes('no author'))).toBe(true);
    });
});
