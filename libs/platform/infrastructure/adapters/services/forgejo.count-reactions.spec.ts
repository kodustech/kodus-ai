const issueGetCommentReactions = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    issueGetCommentReactions: (...args: unknown[]) =>
        issueGetCommentReactions(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — countReactions aligns with the shared reaction contract (#2061)', () => {
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

        return service;
    };

    // The exact shape the reaction use-case passes to the shared
    // codeManagementService.countReactions contract: it builds the pr WITHOUT
    // an id ({ pull_number, repository }) and the comments it already fetched.
    const params = () =>
        ({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            comments: [
                {
                    id: 2,
                    path: 'src/user.ts',
                    pull_request_review_id: 9,
                },
            ],
            pr: {
                pull_number: 7,
                repository: { id: 'repo-1', name: 'acme/widget-api' },
            },
        }) as never;

    beforeEach(() => {
        issueGetCommentReactions.mockReset();
    });

    it('returns per-comment thumbs-up/down counts in the shared contract shape', async () => {
        issueGetCommentReactions.mockResolvedValue({
            data: [
                { content: '+1', user: { login: 'alice' } },
                { content: '+1', user: { login: 'bob' } },
                { content: '-1', user: { login: 'carol' } },
            ],
        });

        const out = await makeService().countReactions(params());

        expect(out).toEqual([
            {
                reactions: { thumbsUp: 2, thumbsDown: 1 },
                comment: { id: 2, pull_request_review_id: 9 },
                pullRequest: {
                    // The caller omits pr.id, so the stable identifier is
                    // derived from the repository id — not an undefined id.
                    id: 'repo-1',
                    number: 7,
                    repository: { id: 'repo-1', fullName: 'acme/widget-api' },
                },
            },
        ]);
        expect(issueGetCommentReactions).toHaveBeenCalledWith({
            client: {},
            path: { owner: 'acme', repo: 'widget-api', id: 2 },
        });
    });

    it('drops a comment that carries no thumbs feedback', async () => {
        issueGetCommentReactions.mockResolvedValue({
            data: [{ content: 'heart', user: { login: 'dave' } }],
        });

        const out = await makeService().countReactions(params());

        expect(out).toEqual([]);
        expect(issueGetCommentReactions).toHaveBeenCalledTimes(1);
    });

    it('keeps the counted reactions when another comment lookup fails', async () => {
        const service = makeService();
        const twoComments = {
            ...params(),
            comments: [
                { id: 2, pull_request_review_id: 9 },
                { id: 5, pull_request_review_id: 9 },
            ],
        };

        issueGetCommentReactions
            .mockResolvedValueOnce({ data: [{ content: '+1' }] })
            .mockRejectedValueOnce(new Error('ECONNRESET'));

        const out = await service.countReactions(twoComments);

        // The failed comment is isolated; the succeeded one is still counted.
        expect(out).toEqual([
            expect.objectContaining({
                reactions: { thumbsUp: 1, thumbsDown: 0 },
                comment: { id: 2, pull_request_review_id: 9 },
            }),
        ]);
        expect(issueGetCommentReactions).toHaveBeenCalledTimes(2);
        expect(service.logger.warn).toHaveBeenCalled();
    });

    it('caps per-comment reaction requests to the concurrency bound', async () => {
        // The use-case runs many PRs concurrently, so an unbounded burst of
        // per-comment calls would hammer a self-hosted Forgejo. GitLab caps
        // its equivalent with a concurrency limiter; Forgejo must too.
        let inFlight = 0;
        let maxInFlight = 0;

        issueGetCommentReactions.mockImplementation(() => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve) =>
                setTimeout(() => {
                    inFlight--;
                    resolve({ data: [{ content: '+1' }] });
                }, 5),
            );
        });

        const manyComments = {
            ...params(),
            comments: Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })),
        };

        await makeService().countReactions(manyComments);

        expect(maxInFlight).toBeLessThanOrEqual(5);
        expect(issueGetCommentReactions).toHaveBeenCalledTimes(12);
    });
});

describe('ForgejoService — getPullRequestReviewComment uses the shared filters contract (#2061)', () => {
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

        return service;
    };

    it('fetches all review comments from the reaction use-case filters', async () => {
        const service = makeService();
        const plural = jest
            .spyOn(service as any, 'getPullRequestReviewComments')
            .mockResolvedValue([{ id: 2 }, { id: 5 }]);

        const out = await (service as any).getPullRequestReviewComment({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            filters: {
                repository: { name: 'acme/widget-api' },
                pullRequestNumber: 7,
            },
        });

        expect(out).toEqual([{ id: 2 }, { id: 5 }]);
        expect(plural).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { name: 'acme/widget-api' },
            prNumber: 7,
        });
    });
});