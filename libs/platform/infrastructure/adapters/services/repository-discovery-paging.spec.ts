jest.mock(
    '../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { AzureReposRequestHelper } from './azureRepos/azure-repos-request-helper';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';

/**
 * "Review every repository" is only as complete as the listing behind it, so
 * discovery reads every page instead of stopping at the first one.
 */

describe('Azure DevOps getProjects', () => {
    it('follows the continuation token until the last page', async () => {
        const helper = new AzureReposRequestHelper();
        const get = jest
            .fn()
            .mockResolvedValueOnce({
                data: { value: [{ id: 'p1' }, { id: 'p2' }] },
                headers: { 'x-ms-continuationtoken': 'next-1' },
            })
            .mockResolvedValueOnce({
                data: { value: [{ id: 'p3' }] },
                headers: {},
            });
        jest.spyOn(helper as any, 'azureRequest').mockResolvedValue({ get });

        const projects = await helper.getProjects({
            orgName: 'acme',
            token: 't',
        });

        expect(projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
        expect(get).toHaveBeenCalledTimes(2);
        expect(get.mock.calls[1][0]).toContain('continuationToken=next-1');
    });
});

describe('Bitbucket Data Center getRepositories', () => {
    it('reads every page of /repos', async () => {
        const service: any = Object.create(BitbucketDataCenterService.prototype);
        Object.defineProperty(service, 'logger', {
            value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });
        jest.spyOn(service, 'getAuthDetails').mockResolvedValue({});
        Object.defineProperty(service, 'integrationService', {
            value: { findOne: jest.fn().mockResolvedValue({ uuid: 'int-1' }) },
        });
        Object.defineProperty(service, 'integrationConfigService', {
            value: { findOne: jest.fn().mockResolvedValue(null) },
        });
        const repo = (id: number) => ({
            id,
            slug: `r${id}`,
            links: { clone: [] },
            project: { key: 'PRJ', id: 1, name: 'Project' },
        });
        const get = jest.fn(async (path: string) =>
            path.includes('start=2')
                ? { data: { values: [repo(3)], isLastPage: true } }
                : {
                      data: {
                          values: [repo(1), repo(2)],
                          isLastPage: false,
                          nextPageStart: 2,
                      },
                  },
        );
        jest.spyOn(service, 'getAxiosInstance').mockReturnValue({ get });

        const repositories = await service.getRepositories({
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        });

        expect(repositories.map((r: { id: string }) => r.id)).toEqual([
            '1',
            '2',
            '3',
        ]);
        expect(get).toHaveBeenCalledTimes(2);
    });
});
