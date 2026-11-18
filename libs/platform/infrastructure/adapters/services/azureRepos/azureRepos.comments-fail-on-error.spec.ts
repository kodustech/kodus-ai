import { AzureReposService } from './azureRepos.service';

// A caller that must tell "no comment" from "the listing failed" (the Runtime
// publisher looking for the comment a lost create posted) passes failOnError,
// as on the other platforms; everyone else keeps the null.
describe('AzureReposService — getAllCommentsInPullRequest failOnError', () => {
    const makeService = (getPullRequestComments: jest.Mock) => {
        const service = Object.create(AzureReposService.prototype) as AzureReposService;
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        Object.defineProperty(service, 'azureReposRequestHelper', {
            value: { getPullRequestComments },
        });
        jest.spyOn(service as unknown as { getAuthDetails: () => Promise<unknown> }, 'getAuthDetails').mockResolvedValue({ orgName: 'acme', token: 'tok' });
        jest.spyOn(service as unknown as { getProjectIdFromRepository: () => Promise<string> }, 'getProjectIdFromRepository').mockResolvedValue('project-1');
        return service;
    };
    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { name: 'widget-api', id: 'repo-uuid' },
        prNumber: 42,
    };

    it('throws a failed listing when the caller asks', async () => {
        const boom = new Error('HTTP 503');
        const service = makeService(jest.fn().mockRejectedValue(boom));
        await expect(service.getAllCommentsInPullRequest({ ...params, failOnError: true })).rejects.toBe(boom);
    });

    it('answers null for a failed listing otherwise', async () => {
        const service = makeService(jest.fn().mockRejectedValue(new Error('HTTP 503')));
        await expect(service.getAllCommentsInPullRequest(params)).resolves.toBeNull();
    });
});
