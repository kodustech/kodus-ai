import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * The PR author list (Settings > Git author filter, license seats, bot
 * discovery) is meant to hold everyone who opened a pull request in the last
 * 60 days. GitHub's "list pull requests" endpoint has no `since` parameter, so
 * reading one page of 100 covered only the newest 100 PRs: on a repository
 * with ~30 PRs a day, dependabot fell out of the list a few days after its
 * last PR and could not be selected in the author filter.
 */
describe('GithubService.getPullRequestAuthors', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const DAY = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

    const pr = (
        number: number,
        createdAt: string,
        user: { id: number; login: string; type: 'User' | 'Bot' },
    ) => ({ number, created_at: createdAt, user });

    const dev = { id: 1, login: 'dev', type: 'User' as const };
    const dependabot = {
        id: 49699333,
        login: 'dependabot[bot]',
        type: 'Bot' as const,
    };
    const formerDev = { id: 2, login: 'former-dev', type: 'User' as const };

    // Serves `pages` newest-first, 100 per page, with the Link header GitHub
    // sends, and records every page that was requested.
    const githubServing = (pages: unknown[][]) => {
        const requestedPages: number[] = [];
        const fetch = jest.fn(async (url: string) => {
            const page = Number(new URL(url).searchParams.get('page') ?? '1');
            requestedPages.push(page);
            const headers: Record<string, string> = {
                'content-type': 'application/json',
            };
            if (page < pages.length) {
                const next = new URL(url);
                next.searchParams.set('page', String(page + 1));
                headers.link = `<${next.toString()}>; rel="next"`;
            }
            return new Response(JSON.stringify(pages[page - 1] ?? []), {
                status: 200,
                headers,
            });
        });
        return {
            octokit: new Octokit({ request: { fetch } }),
            requestedPages,
        };
    };

    const makeService = (octokit: Octokit) => {
        const service = new GithubService(
            {
                getPlatformAuthDetails: jest.fn().mockResolvedValue({
                    org: 'acme',
                    authMode: 'oauth',
                    accountType: 'organization',
                }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: '10', name: 'app', full_name: 'acme/app' }]);
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            octokit,
        );
        return service;
    };

    it('lists an author whose last PR is older than the newest 100 but inside 60 days', async () => {
        const newest100 = Array.from({ length: 100 }, (_, i) =>
            pr(1000 - i, daysAgo(1), dev),
        );
        const { octokit } = githubServing([
            newest100,
            [pr(800, daysAgo(10), dependabot)],
        ]);

        const authors = await makeService(octokit).getPullRequestAuthors({
            organizationAndTeamData,
        });

        expect(authors).toEqual(
            expect.arrayContaining([
                { id: '49699333', name: 'dependabot[bot]', type: 'bot' },
            ]),
        );
    });

    it('leaves out an author whose last PR is older than 60 days, and stops reading there', async () => {
        const newest100 = Array.from({ length: 100 }, (_, i) =>
            pr(1000 - i, daysAgo(1), dev),
        );
        const { octokit, requestedPages } = githubServing([
            newest100,
            [pr(800, daysAgo(10), dependabot), pr(700, daysAgo(61), formerDev)],
            [pr(600, daysAgo(90), formerDev)],
        ]);

        const authors = await makeService(octokit).getPullRequestAuthors({
            organizationAndTeamData,
        });

        expect(authors.map((a) => a.name).sort()).toEqual([
            'dependabot[bot]',
            'dev',
        ]);
        expect(requestedPages).toEqual([1, 2]);
    });
});
