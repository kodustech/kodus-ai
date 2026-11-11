import { BuildFixPromptUseCase } from './build-fix-prompt.use-case';

const issue = (uuid: string, organizationId: string, repoId: string) => ({
    uuid,
    organizationId,
    title: `Issue ${uuid}`,
    description: 'Something is wrong.',
    filePath: 'src/a.ts',
    severity: 'high',
    repository: { id: repoId, name: repoId, full_name: `acme/${repoId}` },
    contributingSuggestions: [],
});

describe('BuildFixPromptUseCase', () => {
    const request: any = {
        user: { uuid: 'u1', organization: { uuid: 'my-org' } },
    };
    const issuesService: any = {
        findById: jest.fn(
            async (id: string) =>
                ({
                    mine: issue('mine', 'my-org', 'repo-a'),
                    other: issue('other', 'my-org', 'repo-b'),
                    foreign: issue('foreign', 'victim-org', 'repo-a'),
                })[id] ?? null,
        ),
    };

    it('carries only the caller organization’s issues in repositories they may read', async () => {
        const authorizationService: any = {
            getRepositoryScope: jest.fn().mockResolvedValue(['repo-a']),
        };
        const useCase = new BuildFixPromptUseCase(
            issuesService,
            request,
            authorizationService,
        );

        const result = await useCase.execute([
            'mine',
            'other',
            'foreign',
            'missing',
        ]);

        expect(result.included).toEqual(['mine']);
        expect(result.skipped).toEqual(['other', 'foreign', 'missing']);
        expect(result.prompt).toContain('Issue mine');
        expect(result.prompt).not.toContain('Issue foreign');
    });

    it('returns an empty prompt when nothing is readable', async () => {
        const authorizationService: any = {
            getRepositoryScope: jest.fn().mockResolvedValue([]),
        };
        const useCase = new BuildFixPromptUseCase(
            issuesService,
            request,
            authorizationService,
        );

        const result = await useCase.execute(['mine']);

        expect(result).toEqual({ prompt: '', included: [], skipped: ['mine'] });
    });
});
