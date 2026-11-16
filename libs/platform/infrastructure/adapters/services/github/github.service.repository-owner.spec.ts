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
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const orgRepository = {
        id: '1460230740',
        name: 'qa2004-empty',
        fullName: 'Novaorg01/qa2004-empty',
    };

    // The saved selection: what the integration connected.
    const connectedRepositories = [
        {
            id: '1460230740',
            name: 'qa2004-empty',
            full_name: 'Novaorg01/qa2004-empty',
            http_url: 'https://github.com/Novaorg01/qa2004-empty',
        },
    ];

    const makeService = (
        octokit: Record<string, any>,
        org = 'Wellington01',
        authMode = 'token',
    ) => {
        const service = new GithubService(
            {
                getPlatformAuthDetails: jest
                    .fn()
                    .mockResolvedValue({ org, authMode, accountType: 'user' }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(connectedRepositories);
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            octokit,
        );
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
            expect.objectContaining({
                owner: 'Novaorg01',
                repo: 'qa2004-empty',
            }),
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
        const service = makeService({
            rest: { reactions: { createForIssue } },
        });

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

    it('ignores an owner no connected repository has, as a forged payload would carry', async () => {
        const get = jest.fn().mockResolvedValue({ data: null });
        const service = makeService({ pulls: { get } });

        await service.getPullRequest({
            organizationAndTeamData,
            repository: {
                id: '1460230740',
                name: 'qa2004-empty',
                fullName: 'SomeoneElse/qa2004-empty',
            },
            prNumber: 1,
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'Wellington01' }),
        );
    });

    it('keeps an App installation on its own account', async () => {
        const get = jest.fn().mockResolvedValue({ data: null });
        const service = makeService({ pulls: { get } }, 'Novaorg01', 'oauth');
        const readSelection = jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        );

        await service.getPullRequest({
            organizationAndTeamData,
            repository: {
                id: '1',
                name: 'api',
                fullName: 'SomeoneElse/api',
            },
            prNumber: 1,
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'Novaorg01' }),
        );
        expect(readSelection).not.toHaveBeenCalled();
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
    it('reads the review status from the repository owner', async () => {
        let args: any;
        const service = makeService({
            rest: { pulls: { listReviews: jest.fn() } },
            paginate: jest.fn(async (_fn: any, a: any) => {
                args = a;
                return [];
            }),
        });
        jest.spyOn(service as any, 'getViewer').mockResolvedValue({
            login: 'kody',
            id: 1,
        });

        await service.getReviewStatusByPullRequest({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
        } as any);

        expect(args).toEqual(expect.objectContaining({ owner: 'Novaorg01' }));
    });

    it('dismisses its own reviews on the repository owner', async () => {
        let args: any;
        const service = makeService({
            rest: {
                pulls: { listReviews: jest.fn(), dismissReview: jest.fn() },
            },
            paginate: jest.fn(async (_fn: any, a: any) => {
                args = a;
                return [];
            }),
        });
        jest.spyOn(service as any, 'getViewer').mockResolvedValue({
            login: 'kody',
            id: 1,
        });

        await service.dismissOwnPullRequestChangeRequests?.({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
        } as any);
        await (service as any).dismissOwnReviews?.({
            organizationAndTeamData,
            repository: orgRepository,
            prNumber: 1,
        });

        expect(args).toEqual(expect.objectContaining({ owner: 'Novaorg01' }));
    });
    it('lists pull requests of same-named repositories under each owner', async () => {
        const service = makeService({});
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([
            {
                name: 'api',
                full_name: 'Novaorg01/api',
                http_url: 'https://github.com/Novaorg01/api',
            },
            {
                name: 'api',
                full_name: 'OtherOrg/api',
                http_url: 'https://github.com/OtherOrg/api',
            },
        ]);
        const getAllPrMessages = jest
            .spyOn(service as any, 'getAllPrMessages')
            .mockResolvedValue([]);

        await service.getListPullRequests(organizationAndTeamData, {});

        const owners = getAllPrMessages.mock.calls.map((call) => call[1]);
        expect(owners.sort()).toEqual(['Novaorg01', 'OtherOrg']);
    });
    it('lists pull requests a few repositories at a time and keeps the others when one fails', async () => {
        const service = makeService({});
        const repos = Array.from({ length: 8 }, (_, i) => ({
            name: `repo-${i}`,
            full_name: `Novaorg01/repo-${i}`,
            http_url: `https://github.com/Novaorg01/repo-${i}`,
        }));
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(repos);
        let inFlight = 0;
        let peak = 0;
        jest.spyOn(service as any, 'getAllPrMessages').mockImplementation(
            async (_octokit: any, _owner: string, repo: string) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight -= 1;
                if (repo === 'repo-3') throw new Error('boom');
                return [{ repo, created_at: '2026-11-16T00:00:00Z' }];
            },
        );

        const result = await service.getListPullRequests(
            organizationAndTeamData,
            {},
        );

        expect(peak).toBeLessThanOrEqual(5);
        expect(result.map((pr: any) => pr.repo).sort()).toEqual(
            repos
                .map((r) => r.name)
                .filter((n) => n !== 'repo-3')
                .sort(),
        );
    });
    it('fails the listing on a rate limit instead of reporting the repository as empty', async () => {
        const service = makeService({});
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([
            {
                name: 'api',
                full_name: 'Novaorg01/api',
                http_url: 'https://github.com/Novaorg01/api',
            },
            {
                name: 'web',
                full_name: 'Novaorg01/web',
                http_url: 'https://github.com/Novaorg01/web',
            },
        ]);
        jest.spyOn(service as any, 'getAllPrMessages').mockImplementation(
            async (_octokit: any, _owner: string, repo: string) => {
                if (repo === 'api') {
                    throw Object.assign(new Error('secondary rate limit'), {
                        status: 403,
                        response: { headers: { 'retry-after': '60' } },
                    });
                }
                return [{ repo, created_at: '2026-11-16T00:00:00Z' }];
            },
        );

        await expect(
            service.getListPullRequests(organizationAndTeamData, {}),
        ).rejects.toMatchObject({ name: 'RateLimitError' });
    });
});
