jest.mock(
    '../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

const forgejoListHooks = jest.fn();
const forgejoCreateHook = jest.fn();
const forgejoEditHook = jest.fn();
jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoListHooks: (...args: unknown[]) => forgejoListHooks(...args),
    repoCreateHook: (...args: unknown[]) => forgejoCreateHook(...args),
    repoEditHook: (...args: unknown[]) => forgejoEditHook(...args),
}));

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';
import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';

/**
 * Every git host sets up the Kodus webhook on a given set of repositories the
 * same way: only the repositories it was handed, without duplicating a hook
 * that is already there, one refused repository not costing the others their
 * hook, and a rate limit stopping the run with the rest left as pending work.
 */

const URL_ = 'https://kodus.example/webhook';
const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

type Behavior = 'missing' | 'present' | 'forbidden' | 'rate_limited';
type Plan = Record<string, Behavior>;

const httpError = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error(`Request failed with status ${status}`), {
        status,
        response: { status, headers },
    });

const failFor = (behavior: Behavior) => {
    if (behavior === 'forbidden') throw httpError(403);
    if (behavior === 'rate_limited')
        throw httpError(429, { 'retry-after': '7' });
};

const quiet = (service: any) =>
    Object.defineProperty(service, 'logger', {
        value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

const repositoriesFor = (ids: string[]) =>
    ids.map((id) => ({
        id,
        name: `r${id}`,
        full_name: `acme/r${id}`,
        organizationName: 'acme',
        workspaceId: 'ws',
        project: { id: 'proj-1', name: 'proj' },
    }));

type Made = {
    service: any;
    created: string[];
    repositories: (ids: string[]) => any[];
};

const HOSTS: Array<{ name: string; make: (plan: Plan) => Made }> = [
    {
        name: 'GitHub (token)',
        make: (plan) => {
            const created: string[] = [];
            const service = quiet(Object.create(GithubService.prototype));
            jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
                authMode: AuthMode.TOKEN,
            });
            jest.spyOn(service, 'getCorrectOwner').mockResolvedValue('acme');
            jest.spyOn(service, 'getGithubWebhookUrl').mockReturnValue(URL_);
            const idOf = (repo: string) => repo.replace(/^r/, '');
            jest.spyOn(service, 'instanceOctokit').mockResolvedValue({
                repos: {
                    listWebhooks: jest.fn(async ({ repo }) => {
                        const behavior = plan[idOf(repo)];
                        if (behavior === 'rate_limited') failFor(behavior);
                        return {
                            data:
                                behavior === 'present'
                                    ? [{ id: 9, config: { url: URL_ } }]
                                    : [],
                        };
                    }),
                    createWebhook: jest.fn(async ({ repo }) => {
                        failFor(plan[idOf(repo)]);
                        created.push(idOf(repo));
                        return { data: { id: 1 } };
                    }),
                    deleteWebhook: jest.fn(),
                },
            });
            return { service, created, repositories: repositoriesFor };
        },
    },
    {
        name: 'GitLab',
        make: (plan) => {
            const created: string[] = [];
            process.env.API_GITLAB_CODE_MANAGEMENT_WEBHOOK = URL_;
            const service = quiet(Object.create(GitlabService.prototype));
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            jest.spyOn(service, 'instanceGitlabApi').mockReturnValue({});
            jest.spyOn(service, 'ensureSingleKodusHook').mockImplementation(
                async (_api: unknown, id: any) => {
                    failFor(plan[id]);
                    if (plan[id] === 'missing') created.push(String(id));
                },
            );
            return { service, created, repositories: repositoriesFor };
        },
    },
    {
        name: 'Bitbucket Cloud',
        make: (plan) => {
            const created: string[] = [];
            process.env.GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK = URL_;
            const service = quiet(
                Object.create(BitbucketCloudService.prototype),
            );
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            const idOf = (slug: string) => slug.replace(/[{}]/g, '');
            jest.spyOn(service, 'instanceBitbucketApi').mockReturnValue({
                webhooks: {
                    listForRepo: jest.fn(async ({ repo_slug }) => {
                        const behavior = plan[idOf(repo_slug)];
                        if (behavior === 'rate_limited') failFor(behavior);
                        return {
                            data: {
                                values:
                                    behavior === 'present'
                                        ? [{ url: URL_ }]
                                        : [],
                            },
                        };
                    }),
                    create: jest.fn(async ({ repo_slug }) => {
                        failFor(plan[idOf(repo_slug)]);
                        created.push(idOf(repo_slug));
                    }),
                },
            });
            jest.spyOn(service, 'getPaginatedResults').mockImplementation(
                async (_api: unknown, res: any) => res.data.values,
            );
            return { service, created, repositories: repositoriesFor };
        },
    },
    {
        name: 'Bitbucket Data Center',
        make: (plan) => {
            const created: string[] = [];
            const service = quiet(
                Object.create(BitbucketDataCenterService.prototype),
            );
            Object.defineProperty(service, 'configService', {
                value: { get: () => URL_ },
            });
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            const idOf = (path: string) =>
                path.match(/repos\/r([^/]+)\/webhooks/)![1];
            jest.spyOn(service, 'getAxiosInstance').mockReturnValue({
                get: jest.fn(async (path: string) => {
                    const behavior = plan[idOf(path)];
                    if (behavior === 'rate_limited') failFor(behavior);
                    return {
                        data: {
                            values:
                                behavior === 'present' ? [{ url: URL_ }] : [],
                        },
                    };
                }),
                post: jest.fn(async (path: string) => {
                    failFor(plan[idOf(path)]);
                    created.push(idOf(path));
                }),
            });
            return { service, created, repositories: repositoriesFor };
        },
    },
    {
        name: 'Azure DevOps',
        make: (plan) => {
            const created: string[] = [];
            process.env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK = URL_;
            const service = quiet(Object.create(AzureReposService.prototype));
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({
                orgName: 'acme',
                token: 't',
            });
            jest.spyOn(service, 'hasUsableWebhookToken').mockReturnValue(true);
            const present = Object.entries(plan)
                .filter(([, b]) => b === 'present')
                .flatMap(([id]) =>
                    [
                        'git.pullrequest.created',
                        'git.pullrequest.updated',
                        'ms.vss-code.git-pullrequest-comment-event',
                    ].map((eventType) => ({
                        id: `sub-${id}-${eventType}`,
                        eventType,
                        status: 'enabled',
                        publisherInputs: { projectId: 'proj-1', repository: id },
                        consumerInputs: {
                            url: `${URL_}?token=x&team=${orgTeam.teamId}`,
                        },
                    })),
                );
            Object.defineProperty(service, 'azureReposRequestHelper', {
                value: {
                    listSubscriptions: jest.fn(async () => present),
                    deleteWebhookById: jest.fn(),
                    createSubscriptionForProject: jest.fn(
                        async ({ subscriptionPayload }) => {
                            const id =
                                subscriptionPayload.publisherInputs.repository;
                            failFor(plan[id]);
                            if (!created.includes(id)) created.push(id);
                            return { id: 'new' };
                        },
                    ),
                },
            });
            return { service, created, repositories: repositoriesFor };
        },
    },
    {
        name: 'Forgejo',
        make: (plan) => {
            const created: string[] = [];
            const service = quiet(Object.create(ForgejoService.prototype));
            Object.defineProperty(service, 'configService', {
                value: { get: () => URL_ },
            });
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            jest.spyOn(service, 'createForgejoClient').mockReturnValue({});
            const idOf = (repo: string) => repo.replace(/^r/, '');
            forgejoListHooks.mockImplementation(async ({ path }) => {
                const behavior = plan[idOf(path.repo)];
                if (behavior === 'rate_limited') {
                    return {
                        error: { message: 'rate limited' },
                        response: {
                            status: 429,
                            headers: new Headers({ 'retry-after': '7' }),
                        },
                    };
                }
                return {
                    data:
                        behavior === 'present'
                            ? [
                                  {
                                      id: 1,
                                      config: { url: URL_ },
                                      events: [
                                          'push',
                                          'pull_request',
                                          'issue_comment',
                                          'pull_request_review',
                                          'pull_request_review_comment',
                                      ],
                                  },
                              ]
                            : [],
                    response: { status: 200 },
                };
            });
            forgejoCreateHook.mockImplementation(async ({ path }) => {
                const id = idOf(path.repo);
                if (plan[id] === 'forbidden') {
                    return {
                        error: { message: 'forbidden' },
                        response: { status: 403, headers: new Headers() },
                    };
                }
                created.push(id);
                return { data: { id: 2 }, response: { status: 201 } };
            });
            const repositories = (ids: string[]) =>
                repositoriesFor(ids).map((r) => ({
                    ...r,
                    name: `acme/${r.name}`,
                }));
            return { service, created, repositories };
        },
    },
];

describe.each(HOSTS)('ensureRepositoryWebhooks — $name', ({ make }) => {
    afterEach(() => jest.clearAllMocks());

    it('creates the hook only where it is missing, only on the repositories it was given', async () => {
        const { service, created, repositories } = make({
            '1': 'missing',
            '2': 'present',
            '3': 'missing',
        });

        const result = await service.ensureRepositoryWebhooks({
            organizationAndTeamData: orgTeam,
            repositories: repositories(['1', '2']),
        });

        expect(created).toEqual(['1']);
        expect(result.configured.sort()).toEqual(['1', '2']);
        expect(result.failed).toEqual({});
        expect(result.notAttempted).toEqual([]);
    });

    it('records a refused repository as a permission error and still sets up the others', async () => {
        const { service, created, repositories } = make({
            '1': 'forbidden',
            '2': 'missing',
        });

        const result = await service.ensureRepositoryWebhooks({
            organizationAndTeamData: orgTeam,
            repositories: repositories(['1', '2']),
        });

        expect(created).toEqual(['2']);
        expect(result.configured).toEqual(['2']);
        expect(result.failed['1'].kind).toBe('permission');
    });

    it('stops at a rate limit and leaves the remaining repositories as pending', async () => {
        const { service, created, repositories } = make({
            '1': 'missing',
            '2': 'rate_limited',
            '3': 'missing',
        });

        const result = await service.ensureRepositoryWebhooks({
            organizationAndTeamData: orgTeam,
            repositories: repositories(['1', '2', '3']),
        });

        expect(created).toEqual(['1']);
        expect(result.failed['2']).toMatchObject({
            kind: 'rate_limited',
            retryAfterMs: 7_000,
        });
        expect(result.notAttempted).toEqual(['3']);
        expect(result.rateLimited).toEqual({ retryAfterMs: 7_000 });
    });

    it('returns an empty result for no repositories', async () => {
        const { service } = make({});

        const result = await service.ensureRepositoryWebhooks({
            organizationAndTeamData: orgTeam,
            repositories: [],
        });

        expect(result).toMatchObject({
            configured: [],
            failed: {},
            notAttempted: [],
        });
    });
});

describe('ensureRepositoryWebhooks — GitHub App', () => {
    it('touches nothing: the app-level hook already delivers every installed repository', async () => {
        const service = quiet(Object.create(GithubService.prototype));
        jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.OAUTH,
        });
        const instanceOctokit = jest.spyOn(service, 'instanceOctokit');

        const result = await service.ensureRepositoryWebhooks({
            organizationAndTeamData: orgTeam,
            repositories: repositoriesFor(['1']),
        });

        expect(instanceOctokit).not.toHaveBeenCalled();
        expect(result).toEqual({
            configured: ['1'],
            failed: {},
            notAttempted: [],
            managedByApp: true,
        });
    });
});
