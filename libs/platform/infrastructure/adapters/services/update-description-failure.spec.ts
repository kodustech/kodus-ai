const repoEditPullRequest = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoEditPullRequest: (...args: unknown[]) => repoEditPullRequest(...args),
}));

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';

/**
 * #2380: writing the summary into the PR description failed silently on these
 * four code hosts: the service logged and returned null, so the review said
 * "Updated summary" and the user never learned it was missing. The caller
 * (`updateSummarizationInPR`) only treats a throw as a failure, as on GitHub
 * and GitLab.
 */
const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const params = {
    organizationAndTeamData,
    repository: { id: 'repo-1', name: 'acme/widget-api' },
    prNumber: 7,
    summary: 'the summary',
};
const forbidden = Object.assign(new Error('Request failed with status 403'), {
    response: { status: 403 },
});

function bare<T>(cls: { prototype: T }): T {
    const service = Object.create(cls.prototype) as T;
    Object.defineProperty(service, 'logger', {
        value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        configurable: true,
    });
    return service;
}

describe('a failed PR description write reaches the caller', () => {
    it('on Azure Repos', async () => {
        const service = bare(AzureReposService);
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'acme',
            token: 'tok',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-1');
        Object.defineProperty(service, 'azureReposRequestHelper', {
            value: {
                updatePullRequestDescription: jest
                    .fn()
                    .mockRejectedValue(forbidden),
            },
        });

        await expect(
            service.updateDescriptionInPullRequest({
                ...params,
                repository: { id: 'repo-1', project: { id: 'project-1' } },
            }),
        ).rejects.toBe(forbidden);
    });

    it('on Bitbucket Cloud', async () => {
        const service = bare(BitbucketCloudService);
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(
            service as any,
            'getWorkspaceFromRepository',
        ).mockResolvedValue('ws-1');
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
            pullrequests: { update: jest.fn().mockRejectedValue(forbidden) },
        });

        await expect(
            service.updateDescriptionInPullRequest(params),
        ).rejects.toBe(forbidden);
    });

    describe('on Bitbucket Data Center', () => {
        const make = () => {
            const service = bare(BitbucketDataCenterService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
            jest.spyOn(service as any, 'getRepoConfig').mockResolvedValue({
                workspaceId: 'PRJ',
                name: 'widget-api',
            });
            return service;
        };

        it('when the write is refused', async () => {
            const service = make();
            jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({
                get: jest
                    .fn()
                    .mockResolvedValue({ data: { title: 't', version: 3 } }),
                put: jest.fn().mockRejectedValue(forbidden),
            });

            await expect(
                service.updateDescriptionInPullRequest(params),
            ).rejects.toBe(forbidden);
        });

        it('when there are no credentials to write with', async () => {
            const service = make();
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue(
                null,
            );

            await expect(
                service.updateDescriptionInPullRequest(params),
            ).rejects.toThrow(/credentials|repository/i);
        });
    });

    describe('on Forgejo', () => {
        const make = () => {
            const service = bare(ForgejoService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
                host: 'https://git.test',
            });
            jest.spyOn(service, 'createForgejoClient').mockReturnValue(
                {} as never,
            );
            return service;
        };

        beforeEach(() => repoEditPullRequest.mockReset());

        it('asks the client to throw on an error answer, and lets it through', async () => {
            const service = make();
            repoEditPullRequest.mockRejectedValue(forbidden);

            await expect(
                service.updateDescriptionInPullRequest(params),
            ).rejects.toBe(forbidden);
            expect(repoEditPullRequest).toHaveBeenCalledWith(
                expect.objectContaining({ throwOnError: true }),
            );
        });

        it('when there are no credentials to write with', async () => {
            const service = make();
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue(
                null,
            );

            await expect(
                service.updateDescriptionInPullRequest(params),
            ).rejects.toThrow(/credentials|repository/i);
        });
    });
});
