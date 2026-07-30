import { CountRulesByRepositoryUseCase } from '@libs/kodyRules/application/use-cases/count-rules-by-repository.use-case';

/**
 * The use-case delegates counting to the service (one aggregation) and then
 * applies the caller's repository read-scope. These tests pin the scope
 * filtering, which is the only branching logic here.
 */
describe('CountRulesByRepositoryUseCase', () => {
    const ALL_COUNTS = [
        { repositoryId: 'repo-a', directoryId: null, count: 3 },
        { repositoryId: 'repo-b', directoryId: null, count: 5 },
        { repositoryId: 'global', directoryId: null, count: 2 },
    ];

    const build = (params: {
        repoScope: string[] | null | undefined;
        hasUser?: boolean;
    }) => {
        const kodyRulesService = {
            countRulesByRepository: jest.fn().mockResolvedValue(ALL_COUNTS),
        };
        const authorizationService = {
            getRepositoryScope: jest.fn().mockResolvedValue(params.repoScope),
        };
        const request =
            params.hasUser === false
                ? ({} as any)
                : { user: { organization: { uuid: 'org-1' } } };

        const useCase = new CountRulesByRepositoryUseCase(
            kodyRulesService as any,
            request as any,
            authorizationService as any,
        );
        return { useCase, kodyRulesService, authorizationService };
    };

    it('returns every count when the user has an unrestricted scope (null)', async () => {
        const { useCase } = build({ repoScope: null });
        const result = await useCase.execute();
        expect(result).toEqual(ALL_COUNTS);
    });

    it('filters to allowed repos and always keeps global', async () => {
        const { useCase } = build({ repoScope: ['repo-a'] });
        const result = await useCase.execute();

        const ids = result.map((r) => r.repositoryId).sort();
        expect(ids).toEqual(['global', 'repo-a']);
        // repo-b is outside the scope and dropped.
        expect(result.find((r) => r.repositoryId === 'repo-b')).toBeUndefined();
    });

    it('throws when there is no organization on the request', async () => {
        const { useCase } = build({ repoScope: null, hasUser: false });
        await expect(useCase.execute()).rejects.toThrow(
            'Organization ID not found',
        );
    });
});
