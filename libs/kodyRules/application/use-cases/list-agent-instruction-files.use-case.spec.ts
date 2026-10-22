import { ListAgentInstructionFilesUseCase } from './list-agent-instruction-files.use-case';

const user = { uuid: 'u1', organization: { uuid: 'org-1' } };

const build = (opts: {
    repositories: Array<{ id: string; name: string; isSelected?: boolean }>;
    files: Record<string, string[] | Error>;
    scope?: string[] | null;
}) => {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({
            configValue: { repositories: opts.repositories },
        }),
    };
    const codeManagementService = {
        getRepositoryAllFiles: jest
            .fn()
            .mockImplementation(async ({ repository }: any) => {
                const value = opts.files[repository.id];
                if (value instanceof Error) throw value;
                return (value ?? []).map((path) => ({ path }));
            }),
    };
    const authorizationService = {
        getRepositoryScope: jest
            .fn()
            .mockResolvedValue(opts.scope === undefined ? null : opts.scope),
    };
    const useCase = new ListAgentInstructionFilesUseCase(
        parametersService as any,
        codeManagementService as any,
        authorizationService as any,
        { user } as any,
    );
    return { useCase, codeManagementService };
};

describe('ListAgentInstructionFilesUseCase', () => {
    it('lists the prose instruction files of each selected repository', async () => {
        const { useCase } = build({
            repositories: [
                { id: 'r1', name: 'api' },
                { id: 'r2', name: 'web', isSelected: false },
            ],
            files: {
                r1: [
                    'CLAUDE.md',
                    'services/billing/AGENTS.md',
                    '.claude/settings.json',
                    '.cursor/rules/style.mdc',
                ],
            },
        });

        await expect(useCase.execute({ teamId: 't1' })).resolves.toEqual([
            {
                repositoryId: 'r1',
                repositoryName: 'api',
                files: [
                    '.cursor/rules/style.mdc',
                    'CLAUDE.md',
                    'services/billing/AGENTS.md',
                ],
            },
        ]);
    });

    it('reports a repository the git host could not list instead of failing the rest', async () => {
        const { useCase } = build({
            repositories: [
                { id: 'r1', name: 'api' },
                { id: 'r2', name: 'web' },
            ],
            files: { r1: ['AGENTS.md'], r2: new Error('rate limited') },
        });

        await expect(useCase.execute({ teamId: 't1' })).resolves.toEqual([
            { repositoryId: 'r1', repositoryName: 'api', files: ['AGENTS.md'] },
            {
                repositoryId: 'r2',
                repositoryName: 'web',
                files: [],
                unavailable: true,
            },
        ]);
    });

    it('only lists repositories the user may read', async () => {
        const { useCase, codeManagementService } = build({
            repositories: [
                { id: 'r1', name: 'api' },
                { id: 'r2', name: 'web' },
            ],
            files: { r1: ['AGENTS.md'], r2: ['CLAUDE.md'] },
            scope: ['r2'],
        });

        const result = await useCase.execute({ teamId: 't1' });

        expect(result.map((r) => r.repositoryId)).toEqual(['r2']);
        expect(codeManagementService.getRepositoryAllFiles).toHaveBeenCalledTimes(
            1,
        );
    });
});
