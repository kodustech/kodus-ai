import { BitbucketService } from './bitbucket.service';

/**
 * Mutation-killing tests for the deterministic pure logic in BitbucketService:
 *   - countReactions
 *   - formatReviewCommentBody
 *
 * The constructor deps are irrelevant to these two methods, so we pass inert
 * stubs (`{} as any`) for every one of them.
 */
describe('BitbucketService — deterministic logic', () => {
    let service: BitbucketService;

    beforeEach(() => {
        service = new BitbucketService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    });

    // Helper: minimal PR object used by countReactions output mapping.
    const buildPr = () => ({
        id: 'pr-id-1',
        pull_number: 42,
        repository: { id: 'repo-id-1', name: 'my/repo' },
    });

    describe('countReactions', () => {
        it('excludes comments without replies and comments with an empty replies array (length > 0 boundary)', async () => {
            const pr = buildPr();
            const comments = [
                { id: 'c-no-replies', body: 'a' }, // replies undefined -> filtered out
                { id: 'c-empty-replies', body: 'b', replies: [] }, // length 0 -> filtered out (boundary)
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result).toEqual([]);
        });

        it('counts a single thumbs up and returns the exact ReactionsInComments shape', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'original body',
                    replies: [
                        {
                            user: { uuid: 'u1' },
                            content: { raw: 'great 👍' },
                        },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result).toEqual([
                {
                    reactions: { thumbsUp: 1, thumbsDown: 0 },
                    comment: {
                        id: 'c1',
                        body: 'original body',
                        pull_request_review_id: 42,
                    },
                    pullRequest: {
                        id: 'pr-id-1',
                        number: 42,
                        repository: {
                            id: 'repo-id-1',
                            fullName: 'my/repo',
                        },
                    },
                },
            ]);
        });

        it('counts thumbs up and thumbs down independently and sums totalReactions', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'b',
                    replies: [
                        { user: { uuid: 'u1' }, content: { raw: '👍' } },
                        { user: { uuid: 'u2' }, content: { raw: '👎' } },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result[0].reactions).toEqual({ thumbsUp: 1, thumbsDown: 1 });
        });

        it('dedupes multiple identical reactions from the SAME user (counts once)', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'b',
                    replies: [
                        { user: { uuid: 'u1' }, content: { raw: '👍' } },
                        { user: { uuid: 'u1' }, content: { raw: 'again 👍' } },
                        { user: { uuid: 'u1' }, content: { raw: '👎' } },
                        { user: { uuid: 'u1' }, content: { raw: 'again 👎' } },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            // Same user thumbs-up twice and thumbs-down twice -> 1 each.
            expect(result[0].reactions).toEqual({ thumbsUp: 1, thumbsDown: 1 });
        });

        it('counts the same emoji from DIFFERENT users separately', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'b',
                    replies: [
                        { user: { uuid: 'u1' }, content: { raw: '👍' } },
                        { user: { uuid: 'u2' }, content: { raw: '👍' } },
                        { user: { uuid: 'u3' }, content: { raw: '👍' } },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result[0].reactions).toEqual({ thumbsUp: 3, thumbsDown: 0 });
        });

        it('excludes a comment that has replies but zero reactions (totalReactions > 0 boundary)', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'b',
                    replies: [
                        { user: { uuid: 'u1' }, content: { raw: 'no emoji' } },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result).toEqual([]);
        });

        it('does not throw when a reply body is null/undefined (optional chaining guard)', async () => {
            const pr = buildPr();
            const comments = [
                {
                    id: 'c1',
                    body: 'b',
                    replies: [
                        { user: { uuid: 'u1' }, content: { raw: null } },
                        { user: { uuid: 'u2' }, content: { raw: undefined } },
                        { user: { uuid: 'u3' }, content: { raw: '👍' } },
                    ],
                },
            ];

            const result = await (service as any).countReactions({
                comments,
                pr,
            });

            expect(result[0].reactions).toEqual({ thumbsUp: 1, thumbsDown: 0 });
        });

        it("skips Kody's own replies, which carry the kody|code-review chip", async () => {
            const result = await (service as any).countReactions({
                comments: [
                    {
                        id: 'c1',
                        body: 'finding',
                        replies: [
                            {
                                user: { uuid: 'kody' },
                                content: {
                                    raw: '`kody|code-review` Kody answer 👍',
                                },
                            },
                            {
                                user: { uuid: 'dev' },
                                content: { raw: '👎' },
                            },
                        ],
                    },
                ],
                pr: buildPr(),
            });

            expect(result[0].reactions).toEqual({ thumbsUp: 0, thumbsDown: 1 });
        });

        it('returns [] as a fail-safe fallback when the input throws', async () => {
            const pr = buildPr();
            // comments is not an array -> .filter throws -> catch returns [].
            const result = await (service as any).countReactions({
                comments: null,
                pr,
            });

            expect(result).toEqual([]);
        });
    });

    describe('formatReviewCommentBody', () => {
        const FOOTER =
            'Was this suggestion helpful? Reply with 👍 or 👎 to help Kody learn from this interaction.\n\n```\n👍\n```\n\n```\n👎\n```';

        it('renders chips, the bold title, the body, the action statement and the footer, with no code', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: {
                    severity: 'high',
                    label: 'bug',
                    oneSentenceSummary: 'User can be null',
                    suggestionContent: 'Fix this',
                    clusteringInformation: { actionStatement: 'Do it now' },
                    improvedCode: 'const x = 1;',
                },
                repository: { name: 'r', language: 'TypeScript' },
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe(
                '`kody|code-review` `bug` `severity-level|high`\n\n' +
                    '**User can be null**\n\n' +
                    'Fix this\n\n' +
                    'Do it now\n\n' +
                    FOOTER,
            );
            expect(body).not.toContain('const x = 1;');
        });

        it('omits the header when includeHeader is false', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: { severity: 'high', label: 'bug' },
                repository: { name: 'r', language: 'ts' },
                includeHeader: false,
                includeFooter: false,
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe('');
        });

        it('uses empty-string defaults for missing severity and label in the header', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: {},
                repository: { name: 'r', language: 'ts' },
                includeHeader: true,
                includeFooter: false,
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe('`kody|code-review` `` `severity-level|`');
        });

        it('applies header AND footer by default when the flags are omitted', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: { severity: 'low', label: 'style' },
                repository: { name: 'r', language: 'ts' },
                organizationAndTeamData: {} as any,
            });

            expect(
                body.startsWith(
                    '`kody|code-review` `style` `severity-level|low`',
                ),
            ).toBe(true);
            expect(body.endsWith(FOOTER)).toBe(true);
        });

        it('includes only the suggestion content when other parts are absent', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: { suggestionContent: 'Hello world' },
                repository: { name: 'r', language: 'ts' },
                includeHeader: false,
                includeFooter: false,
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe('Hello world');
        });

        it('omits the action statement when clusteringInformation.actionStatement is absent', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: {
                    suggestionContent: 'Content',
                    clusteringInformation: {},
                },
                repository: { name: 'r', language: 'ts' },
                includeHeader: false,
                includeFooter: false,
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe('Content');
        });

        it('translates the footer into the review language', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: {},
                repository: { name: 'r', language: 'ts' },
                includeHeader: false,
                includeFooter: true,
                language: 'pt-BR',
                organizationAndTeamData: {} as any,
            });

            expect(body.startsWith('Essa sugestão foi útil? Responda com 👍 ou 👎')).toBe(true);
        });

        it('renders only the footer when includeFooter is true and everything else is empty', async () => {
            const body = await service.formatReviewCommentBody({
                suggestion: {},
                repository: { name: 'r', language: 'ts' },
                includeHeader: false,
                includeFooter: true,
                organizationAndTeamData: {} as any,
            });

            expect(body).toBe(FOOTER);
        });
    });
});
