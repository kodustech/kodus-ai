import { GetRepositoriesUseCase } from '../get-repositories';

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (reposByConnection: Record<string, Array<{ id: string }>>) => {
    const codeManagementService = {
        getRepositories: jest.fn(async (params: any) =>
            (
                reposByConnection[
                    params.organizationAndTeamData.integrationId
                ] ?? []
            ).map((repo) => ({ ...repo, selected: false })),
        ),
    };
    const integrationService = {
        find: jest.fn(async () =>
            Object.keys(reposByConnection).map((uuid) => ({ uuid })),
        ),
    };
    const useCase = new GetRepositoriesUseCase(
        codeManagementService as any,
        { getRepositoryScope: jest.fn().mockResolvedValue(null) } as any,
        { user: { organization: { uuid: ORG } } } as any,
        integrationService as any,
    );
    return { useCase, codeManagementService };
};

describe('GetRepositoriesUseCase — Git connections', () => {
    it('lists the repositories of the named connection', async () => {
        const { useCase, codeManagementService } = build({
            'gh-a': [{ id: '1' }],
            'gl-b': [{ id: '2' }],
        });

        const result = await useCase.execute({
            teamId: TEAM,
            organizationSelected: undefined,
            connectionId: 'gl-b',
        });

        expect(codeManagementService.getRepositories).toHaveBeenCalledTimes(1);
        expect(result).toEqual([
            { id: '2', selected: false, connectionId: 'gl-b' },
        ]);
    });

    it('lists every connection’s repositories, each tagged with its connection, when none is named', async () => {
        const { useCase } = build({
            'gh-a': [{ id: '1' }],
            'gl-b': [{ id: '2' }],
        });

        const result = await useCase.execute({
            teamId: TEAM,
            organizationSelected: undefined,
        });

        expect(result).toEqual([
            { id: '1', selected: false, connectionId: 'gh-a' },
            { id: '2', selected: false, connectionId: 'gl-b' },
        ]);
    });
});
