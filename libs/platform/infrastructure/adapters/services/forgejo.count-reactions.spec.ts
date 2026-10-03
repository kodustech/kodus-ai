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
    // codeManagementService.countReactions contract. Forgejo must consume it
    // rather than its own old { repository, prNumber } shape.
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
                id: 3,
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
                    id: 3,
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
});