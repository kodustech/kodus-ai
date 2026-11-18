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

    const newest100 = () =>
        Array.from({ length: 100 }, (_, i) => pr(1000 - i, daysAgo(1), dev));

    type Repo = {
        pages: unknown[][];
        // Page number answered with this HTTP status instead of its PRs.
        fail?: { page: number; status: number };
    };

    // Serves each repository's `pages` newest-first, 100 per page, with the
    // Link header GitHub sends. Records every request and how many were in
    // flight at once.
    const githubServing = (repos: Record<string, Repo>) => {
        const requests: URL[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const fetch = jest.fn(async (url: string) => {
            const request = new URL(url);
            requests.push(request);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;

            const name = request.pathname.split('/')[3];
            const repo = repos[name];
            const page = Number(request.searchParams.get('page') ?? '1');
            if (!repo || repo.fail?.page === page) {
                return new Response(JSON.stringify({ message: 'fail' }), {
                    status: repo?.fail?.status ?? 404,
                    headers: { 'content-type': 'application/json' },
                });
            }
            const headers: Record<string, string> = {
                'content-type': 'application/json',
            };
            if (page < repo.pages.length) {
                const next = new URL(url);
                next.searchParams.set('page', String(page + 1));
                headers.link = `<${next.toString()}>; rel="next"`;
            }
            return new Response(JSON.stringify(repo.pages[page - 1] ?? []), {
                status: 200,
                headers,
            });
        });
        return {
            octokit: new Octokit({
                request: { fetch },
                log: { debug() {}, info() {}, warn() {}, error() {} },
            }),
            requests,
            pagesOf: (name: string) =>
                requests
                    .filter((r) => r.pathname.split('/')[3] === name)
                    .map((r) => Number(r.searchParams.get('page') ?? '1')),
            maxInFlight: () => maxInFlight,
        };
    };

    const makeService = (octokit: Octokit, repoNames: string[]) => {
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
        (service as any).logger = {
            error: jest.fn(),
            warn: jest.fn(),
            log: jest.fn(),
        };
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(
            repoNames.map((name, i) => ({
                id: String(10 + i),
                name,
                full_name: `acme/${name}`,
            })),
        );
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            octokit,
        );
        return service;
    };

    it('lists an author whose last PR is older than the newest 100 but inside 60 days', async () => {
        const github = githubServing({
            app: { pages: [newest100(), [pr(800, daysAgo(10), dependabot)]] },
        });

        const authors = await makeService(github.octokit, [
            'app',
        ]).getPullRequestAuthors({ organizationAndTeamData });

        expect(authors).toEqual(
            expect.arrayContaining([
                { id: '49699333', name: 'dependabot[bot]', type: 'bot' },
            ]),
        );
    });

    it('asks for every state, newest created first, which the early stop relies on', async () => {
        const github = githubServing({ app: { pages: [newest100()] } });

        await makeService(github.octokit, ['app']).getPullRequestAuthors({
            organizationAndTeamData,
        });

        const params = Object.fromEntries(github.requests[0].searchParams);
        expect(params).toEqual(
            expect.objectContaining({
                state: 'all',
                sort: 'created',
                direction: 'desc',
                per_page: '100',
            }),
        );
    });

    it('leaves out an author whose last PR is older than 60 days, and stops reading there', async () => {
        const github = githubServing({
            app: {
                pages: [
                    newest100(),
                    [
                        pr(800, daysAgo(10), dependabot),
                        pr(700, daysAgo(61), formerDev),
                    ],
                    [pr(600, daysAgo(90), formerDev)],
                ],
            },
        });

        const authors = await makeService(github.octokit, [
            'app',
        ]).getPullRequestAuthors({ organizationAndTeamData });

        expect(authors.map((a) => a.name).sort()).toEqual([
            'dependabot[bot]',
            'dev',
        ]);
        expect(github.pagesOf('app')).toEqual([1, 2]);
    });

    it('keeps the authors of pages already read when a later page fails', async () => {
        const github = githubServing({
            app: {
                pages: [newest100(), [pr(800, daysAgo(10), dependabot)]],
                fail: { page: 2, status: 403 },
            },
        });

        const authors = await makeService(github.octokit, [
            'app',
        ]).getPullRequestAuthors({ organizationAndTeamData });

        expect(authors.map((a) => a.name)).toEqual(['dev']);
    });

    it('fails for the seat prune when a repository could not be read, instead of passing for no authors', async () => {
        const github = githubServing({
            app: { pages: [newest100()] },
            api: {
                pages: [newest100(), [pr(800, daysAgo(10), dependabot)]],
                fail: { page: 2, status: 403 },
            },
        });

        await expect(
            makeService(github.octokit, ['app', 'api']).getPullRequestAuthors({
                organizationAndTeamData,
                requireLoaded: true,
            }),
        ).rejects.toThrow('1 of the configured GitHub repositories');
    });

    it('does not fail the seat prune for a configured repository that no longer exists', async () => {
        const github = githubServing({ app: { pages: [newest100()] } });

        const authors = await makeService(github.octokit, [
            'app',
            'deleted',
        ]).getPullRequestAuthors({
            organizationAndTeamData,
            requireLoaded: true,
        });

        expect(authors.map((a) => a.name)).toEqual(['dev']);
    });

    it('walks at most 10 repositories at once, under the 100 concurrent requests GitHub allows', async () => {
        const names = Array.from({ length: 40 }, (_, i) => `repo-${i}`);
        const github = githubServing(
            Object.fromEntries(
                names.map((name) => [name, { pages: [newest100()] }]),
            ),
        );

        const authors = await makeService(
            github.octokit,
            names,
        ).getPullRequestAuthors({ organizationAndTeamData });

        expect(authors.map((a) => a.name)).toEqual(['dev']);
        expect(github.requests).toHaveLength(40);
        expect(github.maxInFlight()).toBe(10);
    });
});
