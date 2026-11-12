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

// Issue ids are Mongo ObjectIds.
const MINE = '6af1075b2a70d4386f58f001';
const OTHER = '6af1075b2a70d4386f58f002';
const FOREIGN = '6af1075b2a70d4386f58f003';
const MISSING = '6af1075b2a70d4386f58f004';

describe('BuildFixPromptUseCase', () => {
    const request: any = {
        user: { uuid: 'u1', organization: { uuid: 'my-org' } },
    };
    const issuesService: any = {
        findById: jest.fn(
            async (id: string) =>
                ({
                    [MINE]: issue(MINE, 'my-org', 'repo-a'),
                    [OTHER]: issue(OTHER, 'my-org', 'repo-b'),
                    [FOREIGN]: issue(FOREIGN, 'victim-org', 'repo-a'),
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

        const result = await useCase.execute([MINE, OTHER, FOREIGN, MISSING]);

        expect(result.included).toEqual([MINE]);
        expect(result.skipped).toEqual([OTHER, FOREIGN, MISSING]);
        expect(result.prompt).toContain(`Issue ${MINE}`);
        expect(result.prompt).not.toContain(`Issue ${FOREIGN}`);
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

        const result = await useCase.execute([MINE]);

        expect(result).toEqual({ prompt: '', included: [], skipped: [MINE] });
    });

    it('skips a malformed id instead of failing the whole prompt', async () => {
        const authorizationService: any = {
            getRepositoryScope: jest.fn().mockResolvedValue(['repo-a']),
        };
        issuesService.findById.mockClear();
        const useCase = new BuildFixPromptUseCase(
            issuesService,
            request,
            authorizationService,
        );

        const result = await useCase.execute([MINE, 'not-an-id']);

        expect(result.included).toEqual([MINE]);
        expect(result.skipped).toEqual(['not-an-id']);
        expect(issuesService.findById).not.toHaveBeenCalledWith('not-an-id');
    });
});
