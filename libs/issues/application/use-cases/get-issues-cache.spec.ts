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

    function useCaseWith(changed: boolean | Error) {
        const store = new Map<string, unknown>([
            [
                `issues_${org}`,
                { issues: [issue('cached')], readAt: '2026-11-12T10:00:00.000Z' },
            ],
        ]);
        const issuesService = {
            find: jest.fn(async () => [issue('fresh')]),
            changedSince: jest.fn(async () => {
                if (changed instanceof Error) throw changed;
                return changed;
            }),
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
        return { useCase, issuesService, store };
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

    it('stores the list and when it was read, taken before the read', async () => {
        const { useCase, issuesService, store } = useCaseWith(true);
        const read = issuesService.find.getMockImplementation()!;
        let readStartedAt = 0;
        issuesService.find.mockImplementation(async (...args: any[]) => {
            readStartedAt = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 5));
            return read(...args);
        });

        await useCase.execute({} as any);

        const entry = store.get(`issues_${org}`) as { issues: any[]; readAt: string };
        expect(entry.issues.map((i) => i.uuid)).toEqual(['fresh']);
        // A write during the read is later than readAt, so the next request
        // reads again.
        expect(new Date(entry.readAt).getTime()).toBeLessThanOrEqual(readStartedAt);
    });

    it('serves the cached list when the check for a later write fails', async () => {
        const { useCase, issuesService } = useCaseWith(new Error('mongo blip'));

        const issues = await useCase.execute({} as any);

        expect(issuesService.find).not.toHaveBeenCalled();
        expect(issues.map((i) => i.uuid)).toEqual(['cached']);
    });

    it('serves the cached list while nothing changed', async () => {
        const { useCase, issuesService } = useCaseWith(false);

        const issues = await useCase.execute({} as any);

        expect(issuesService.find).not.toHaveBeenCalled();
        expect(issues.map((i) => i.uuid)).toEqual(['cached']);
    });
});
