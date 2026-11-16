import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * A token integration records one account as `org` (for a fine-grained token
 * or a personal account, the user's login), but its repositories can belong
 * to other owners: an organization the token was scoped to, or one the user
 * is a member of. Seen on QA for #2004: a fine-grained token scoped to
 * `Novaorg01` was recorded as `org: Wellington01`, and every review call for
 * `Novaorg01/qa2004-empty` asked GitHub for `/repos/Wellington01/qa2004-empty`
 * and got 404, so the review was skipped.
 *
 * GitHub addresses a repository by its own owner, so calls take it from the
 * repository and fall back to the recorded account only when the repository
 * does not carry one.
 */
describe('GithubService addresses a repository by its own owner', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
    const orgRepository = {
        id: '1460230740',
        name: 'qa2004-empty',
        fullName: 'Novaorg01/qa2004-empty',
    };

    const makeService = (octokit: Record<string, any>, org = 'Wellington01') => {
        const service = new GithubService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org,
            authMode: 'token',
            accountType: 'user',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(octokit);
        return service;
    };

    it('reads a pull request from the repository owner, not the recorded account', async () => {
        const get = jest.fn().mockResolvedValue({ data: null });
        const service = makeService({ pulls: { get } });

        await service.getPullRequest({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'Novaorg01', repo: 'qa2004-empty' }),
        );
    });

    it('lists the pull request commits from the repository owner', async () => {
        const listCommits = jest.fn().mockResolvedValue({ data: [] });
        const service = makeService({
            pulls: { listCommits },
            paginate: jest.fn(async (fn: any, args: any) => {
                await fn(args);
                return [];
            }),
        });

        await service.getCommitsForPullRequestForCodeReview({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
        } as any);

        expect(listCommits).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'Novaorg01' }),
        );
    });

    it('reacts on the repository owner', async () => {
        const createForIssue = jest.fn().mockResolvedValue({ data: {} });
        const service = makeService({ rest: { reactions: { createForIssue } } });

        await service.addReactionToPR({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
            reaction: 'rocket',
        } as any);

        expect(createForIssue).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'Novaorg01' }),
        );
    });

    it('falls back to the recorded account when the full name holds no real owner', async () => {
        // `extractRepoData` builds `${organizationName}/${name}`, so a
        // record without an organization arrives as "undefined/api".
        const get = jest.fn().mockResolvedValue({ data: null });
        const service = makeService({ pulls: { get } }, 'acme');

        await service.getPullRequest({
            organizationAndTeamData,
            repository: { id: '1', name: 'api', fullName: 'undefined/api' },
            prNumber: 7,
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'acme', repo: 'api' }),
        );
    });

    it('links the request-changes review to the repository owner', async () => {
        const createReview = jest.fn().mockResolvedValue({ data: {} });
        const service = makeService({
            pulls: { createReview },
            rest: { pulls: { createReview } },
        });

        await service.requestChangesPullRequest({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
            criticalComments: [
                {
                    comment: { suggestion: { suggestionContent: 'Fix it' } },
                    codeReviewFeedbackData: { commentId: 42 },
                } as any,
            ],
        });

        const body: string = createReview.mock.calls[0][0].body;
        expect(body).toContain('/Novaorg01/qa2004-empty/pull/1');
        expect(body).not.toContain('/Wellington01/');
    });
});
