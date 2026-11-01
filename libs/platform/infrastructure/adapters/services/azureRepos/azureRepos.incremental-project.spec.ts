import { AzureReposService } from './azureRepos.service';

/**
 * #2318: the implementation check calls this with a repository reference that
 * never carried its project, and the Azure URLs are built from the project
 * segment: `/undefined/_apis/git/repositories/<id>/pullrequests/<n>` answers
 * 404, which reads downstream as "the PR changed nothing".
 */
describe('AzureReposService.getChangedFilesSinceLastCommit — project segment', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const lastCommit = { sha: 'reviewed-sha' };

    const makeService = (getPullRequestDetails: jest.Mock) => {
        const service = Object.create(
            AzureReposService.prototype,
        ) as AzureReposService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        Object.defineProperty(service, 'azureReposRequestHelper', {
            value: { getPullRequestDetails, getDiff: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({ orgName: 'acme', token: 'tok' });

        const getProjectIdFromRepository = jest
            .spyOn(
                service as unknown as {
                    getProjectIdFromRepository: () => Promise<string | null>;
                },
                'getProjectIdFromRepository',
            )
            .mockResolvedValue('project-from-config');

        return { service, getProjectIdFromRepository };
    };

    /** The PR read stops the method early, so the case asserts on the call it makes. */
    const read = (service: AzureReposService, repository: unknown) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData,
            repository: repository as never,
            prNumber: 185,
            lastCommit,
        });

    it('resolves the project of a repository reference that carries none', async () => {
        const getPullRequestDetails = jest.fn().mockResolvedValue({});
        const { service, getProjectIdFromRepository } = makeService(
            getPullRequestDetails,
        );

        await read(service, { id: 'repo-uuid', name: 'widget-api' });

        expect(getProjectIdFromRepository).toHaveBeenCalledWith(
            organizationAndTeamData,
            'repo-uuid',
        );
        expect(getPullRequestDetails).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: 'project-from-config' }),
        );
    });

    it('keeps the project the repository already carries, without a config read', async () => {
        const getPullRequestDetails = jest.fn().mockResolvedValue({});
        const { service, getProjectIdFromRepository } = makeService(
            getPullRequestDetails,
        );

        await read(service, {
            id: 'repo-uuid',
            name: 'widget-api',
            project: { id: 'project-on-the-reference' },
        });

        expect(getProjectIdFromRepository).not.toHaveBeenCalled();
        expect(getPullRequestDetails).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: 'project-on-the-reference' }),
        );
    });

    it('makes no Azure call when no project can be resolved', async () => {
        const getPullRequestDetails = jest.fn().mockResolvedValue({});
        const { service, getProjectIdFromRepository } = makeService(
            getPullRequestDetails,
        );
        getProjectIdFromRepository.mockResolvedValue(null);

        await expect(
            read(service, { id: 'repo-uuid', name: 'widget-api' }),
        ).resolves.toBeNull();

        expect(getPullRequestDetails).not.toHaveBeenCalled();
    });
});
