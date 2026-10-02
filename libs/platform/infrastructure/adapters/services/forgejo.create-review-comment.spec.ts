const repoCreatePullReview = jest.fn();
const repoGetPullReviewComments = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoCreatePullReview: (...args: unknown[]) => repoCreatePullReview(...args),
    repoGetPullReviewComments: (...args: unknown[]) =>
        repoGetPullReviewComments(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — createReviewComment returns the comment id (#2051)', () => {
    const makeService = () => {
        const service = Object.create(
            ForgejoService.prototype,
        ) as ForgejoService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({ host: 'https://git.test' });

        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
        jest.spyOn(
            service as unknown as { formatBodyForForgejo: () => string },
            'formatBodyForForgejo',
        ).mockReturnValue('a comment body');

        return service;
    };

    const params = () =>
        ({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { name: 'acme/widget-api' },
            prNumber: 7,
            lineComment: { path: 'src/user.ts', line: 10 },
            commit: { sha: 'a1b2c3d4' },
            language: 'typescript',
        }) as never;

    beforeEach(() => {
        repoCreatePullReview.mockReset();
        repoGetPullReviewComments.mockReset();
    });

    it('returns the comment id, not the review id, when the create response has no comments array', async () => {
        // Forgejo 16.0.5 answers the create-review request with the review and
        // `comments_count: 1` but omits the `comments` array, so the created
        // comment (id 2) is only reachable by listing the review's comments.
        repoCreatePullReview.mockResolvedValue({
            data: { id: 1, comments_count: 1 },
        });
        repoGetPullReviewComments.mockResolvedValue({
            data: [
                {
                    id: 2,
                    path: 'src/user.ts',
                    created_at: '2026-10-01T00:00:00Z',
                },
            ],
        });

        const out = await makeService().createReviewComment(params());

        expect(out?.id).toBe(2);
        expect(out?.pullRequestReviewId).toBe('1');
        expect(repoGetPullReviewComments).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { owner: 'acme', repo: 'widget-api', index: 7, id: 1 },
            }),
        );
    });

    it('keeps the review id as the fallback when the comments fetch also returns nothing', async () => {
        repoCreatePullReview.mockResolvedValue({
            data: { id: 1, comments_count: 1 },
        });
        repoGetPullReviewComments.mockResolvedValue({ data: [] });

        const out = await makeService().createReviewComment(params());

        // Never worse than today: if neither the create response nor the
        // review's comment list yields a comment, the review id is still
        // returned rather than nothing.
        expect(out?.id).toBe(1);
    });

    it('passes through the comment from the response when it does carry one', async () => {
        repoCreatePullReview.mockResolvedValue({
            data: {
                id: 1,
                comments: [{ id: 2, body: 'a comment body', created_at: 'x' }],
            },
        });

        const out = await makeService().createReviewComment(params());

        expect(out?.id).toBe(2);
        expect(repoGetPullReviewComments).not.toHaveBeenCalled();
    });
});
