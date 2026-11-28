import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';

/**
 * Two connections of one provider in an organization talk to different
 * servers (github.com and an Enterprise host, two GitLab instances), where
 * the same login, user id or repository id names someone or something else.
 * Their cached answers must not be shared.
 */
const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

const cache = () => {
    const store = new Map<string, unknown>();
    return {
        store,
        getFromCache: jest.fn(async (key: string) => store.get(key)),
        addToCache: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
    };
};

const onConnection = (integrationId: string) => ({
    organizationId: 'org-1',
    teamId: 'team-1',
    integrationId,
});

describe('provider caches with two connections of one provider', () => {
    it('GitHub: a login cached for one host does not answer for another', async () => {
        const cacheService = cache();
        const getByUsername = jest.fn(async ({ username }) => ({
            data: { login: username },
        }));
        const service = make(GithubService, {
            cacheService,
            instanceOctokit: jest.fn(async () => ({
                rest: { users: { getByUsername } },
            })),
        }) as GithubService;

        await service.getUserByUsername({
            organizationAndTeamData: onConnection('gh-cloud'),
            username: 'Ana',
        });
        await service.getUserByUsername({
            organizationAndTeamData: onConnection('gh-enterprise'),
            username: 'ana',
        });

        expect(getByUsername).toHaveBeenCalledTimes(2);
    });

    it('GitHub: a default branch cached for one host does not answer for another', async () => {
        const cacheService = cache();
        const get = jest.fn(async () => ({ data: { default_branch: 'main' } }));
        const service = make(GithubService, {
            cacheService,
            getGithubAuthDetails: jest.fn(async () => ({ org: 'acme' })),
            instanceOctokit: jest.fn(async () => ({ repos: { get } })),
        }) as GithubService;

        for (const integrationId of ['gh-cloud', 'gh-enterprise']) {
            await service.getDefaultBranch({
                organizationAndTeamData: onConnection(integrationId),
                repository: { id: '7', name: 'api' },
            });
        }

        expect(get).toHaveBeenCalledTimes(2);
    });

    it('GitLab: an MR author cached for one instance does not answer for another', async () => {
        const cacheService = cache();
        const getUserById = jest.fn(async ({ organizationAndTeamData }) => ({
            id: 17,
            host: organizationAndTeamData.integrationId,
        }));
        const service = make(GitlabService, {
            cacheService,
            getUserById,
        }) as GitlabService;

        const payload = { object_attributes: { author_id: 17 } };
        const fromA = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: onConnection('gl-a'),
            payload,
        });
        const fromB = await service.resolveMrAuthorFromWebhookPayload({
            organizationAndTeamData: onConnection('gl-b'),
            payload,
        });

        expect(fromA).toEqual({ id: 17, host: 'gl-a' });
        expect(fromB).toEqual({ id: 17, host: 'gl-b' });
    });
});
