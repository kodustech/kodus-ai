import { GetIssuesUseCase } from './get-issues.use-case';

/**
 * The issues list is cached in each process's memory, but a worker (a deep
 * scan, a closed PR) writes issues and clears only its own copy: the API
 * checks for a later write before serving its copy.
 */
describe('GetIssuesUseCase — a cached list another process made stale', () => {
    const org = 'org-1';
    const issue = (uuid: string) =>
        ({
            uuid,
            organizationId: org,
            createdAt: '2026-11-12T00:00:00.000Z',
            repository: { id: 'repo-1', name: 'shop' },
            contributingSuggestions: [],
        }) as any;

    function useCaseWith(changed: boolean) {
        const store = new Map<string, unknown>([
            [`issues_${org}`, [issue('cached')]],
            [`issues_${org}_asOf`, '2026-11-12T10:00:00.000Z'],
        ]);
        const issuesService = {
            find: jest.fn(async () => [issue('fresh')]),
            changedSince: jest.fn(async () => changed),
        };
        const useCase = new GetIssuesUseCase(
            issuesService as any,
            { user: { organization: { uuid: org } } } as any,
            {
                getFromCache: jest.fn(async (k: string) => store.get(k) ?? null),
                addToCache: jest.fn(async (k: string, v: unknown) => store.set(k, v)),
            } as any,
            { getRepositoryScope: jest.fn(async () => null) } as any,
        );
        return { useCase, issuesService };
    }

    it('reads the list again when an issue changed after it was cached', async () => {
        const { useCase, issuesService } = useCaseWith(true);

        const issues = await useCase.execute({} as any);

        expect(issuesService.changedSince).toHaveBeenCalledWith(
            org,
            new Date('2026-11-12T10:00:00.000Z'),
        );
        expect(issuesService.find).toHaveBeenCalledWith(org);
        expect(issues.map((i) => i.uuid)).toEqual(['fresh']);
    });

    it('serves the cached list while nothing changed', async () => {
        const { useCase, issuesService } = useCaseWith(false);

        const issues = await useCase.execute({} as any);

        expect(issuesService.find).not.toHaveBeenCalled();
        expect(issues.map((i) => i.uuid)).toEqual(['cached']);
    });
});
