jest.mock(
    '../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';
import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';

/**
 * Every git host marks archived, forked and mirrored repositories the same
 * way in its listing, so "review every repository" can skip them. A host that
 * has no such concept leaves the flag false.
 */

type Flags = { archived: boolean; fork: boolean; mirror: boolean };
type Kind = 'plain' | 'archived' | 'fork' | 'mirror';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

const quiet = (service: any) =>
    Object.defineProperty(service, 'logger', {
        value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

const withConfigLookups = (service: any) => {
    Object.defineProperty(service, 'integrationService', {
        value: { findOne: jest.fn().mockResolvedValue({ uuid: 'int-1' }) },
    });
    Object.defineProperty(service, 'integrationConfigService', {
        value: { findOne: jest.fn().mockResolvedValue(null) },
    });
    return service;
};

const HOSTS: Array<{
    name: string;
    supports: Kind[];
    list: (kinds: Kind[]) => Promise<Array<{ id: string } & Partial<Flags>>>;
}> = [
    {
        name: 'GitHub',
        supports: ['archived', 'fork', 'mirror'],
        list: async (kinds) => {
            const service = withConfigLookups(
                quiet(Object.create(GithubService.prototype)),
            );
            jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
                accountType: 'organization',
                org: 'acme',
            });
            const repos = kinds.map((kind, i) => ({
                id: i + 1,
                name: `r${i}`,
                full_name: `acme/r${i}`,
                owner: { login: 'acme', avatar_url: '' },
                private: true,
                archived: kind === 'archived',
                fork: kind === 'fork',
                mirror_url: kind === 'mirror' ? 'https://elsewhere/r' : null,
            }));
            jest.spyOn(service, 'instanceOctokit').mockResolvedValue({
                paginate: jest.fn().mockResolvedValue(repos),
                rest: { repos: { listForOrg: jest.fn() } },
            });
            return service.getRepositories({ organizationAndTeamData: orgTeam });
        },
    },
    {
        name: 'GitLab',
        supports: ['archived', 'fork', 'mirror'],
        list: async (kinds) => {
            const service = withConfigLookups(
                quiet(Object.create(GitlabService.prototype)),
            );
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            const projects = kinds.map((kind, i) => ({
                id: i + 1,
                path_with_namespace: `acme/r${i}`,
                namespace: { name: 'acme' },
                default_branch: 'main',
                archived: kind === 'archived',
                forked_from_project:
                    kind === 'fork' ? { id: 99 } : undefined,
                mirror: kind === 'mirror',
            }));
            jest.spyOn(service, 'instanceGitlabApi').mockReturnValue({
                Projects: { all: jest.fn().mockResolvedValue(projects) },
            });
            return service.getRepositories({ organizationAndTeamData: orgTeam });
        },
    },
    {
        name: 'Bitbucket Cloud',
        supports: ['fork'],
        list: async (kinds) => {
            const service = quiet(
                Object.create(BitbucketCloudService.prototype),
            );
            return kinds.map((kind, i) =>
                service.transformRepo(
                    {
                        uuid: `{r${i}}`,
                        name: `r${i}`,
                        parent: kind === 'fork' ? { uuid: '{x}' } : undefined,
                    },
                    { slug: 'acme', uuid: '{ws}' },
                    null,
                ),
            );
        },
    },
    {
        name: 'Bitbucket Data Center',
        supports: ['archived', 'fork'],
        list: async (kinds) => {
            const service = withConfigLookups(
                quiet(Object.create(BitbucketDataCenterService.prototype)),
            );
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
            const values = kinds.map((kind, i) => ({
                id: i + 1,
                slug: `r${i}`,
                links: { clone: [] },
                project: { key: 'PRJ', id: 1, name: 'Project' },
                archived: kind === 'archived',
                origin: kind === 'fork' ? { id: 99 } : undefined,
            }));
            jest.spyOn(service, 'getAxiosInstance').mockReturnValue({
                get: jest
                    .fn()
                    .mockResolvedValue({ data: { values, isLastPage: true } }),
            });
            return service.getRepositories({ organizationAndTeamData: orgTeam });
        },
    },
    {
        name: 'Azure DevOps',
        supports: ['archived', 'fork'],
        list: async (kinds) => {
            const service = quiet(Object.create(AzureReposService.prototype));
            return kinds.map((kind, i) =>
                service.transformRepo(
                    {
                        id: `r${i}`,
                        name: `r${i}`,
                        isDisabled: kind === 'archived',
                        isFork: kind === 'fork',
                    },
                    { id: 'p', name: 'Project' },
                    null,
                ),
            );
        },
    },
    {
        name: 'Forgejo',
        supports: ['archived', 'fork', 'mirror'],
        list: async (kinds) => {
            const service = quiet(Object.create(ForgejoService.prototype));
            return kinds.map((kind, i) =>
                service.transformRepository(
                    {
                        id: i + 1,
                        full_name: `acme/r${i}`,
                        owner: { login: 'acme' },
                        archived: kind === 'archived',
                        fork: kind === 'fork',
                        mirror: kind === 'mirror',
                    },
                    null,
                ),
            );
        },
    },
];

describe.each(HOSTS)('repository listing flags — $name', ({ supports, list }) => {
    it('marks archived, forked and mirrored repositories, and leaves a plain one unmarked', async () => {
        const kinds: Kind[] = ['plain', ...supports];

        const repositories = await list(kinds);

        repositories.forEach((repository, index) => {
            const kind = kinds[index];
            expect({
                archived: repository.archived,
                fork: repository.fork,
                mirror: repository.mirror,
            }).toEqual({
                archived: kind === 'archived',
                fork: kind === 'fork',
                mirror: kind === 'mirror',
            });
        });
    });
});
