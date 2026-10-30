import { IssuesRepository } from './issues.repository';

describe('IssuesRepository.findByFilters', () => {
    it('returns an empty list when no issue matches', async () => {
        const issuesModel = {
            find: jest.fn(() => ({ exec: jest.fn(async () => []) })),
        };
        const repository = new IssuesRepository(issuesModel as any);

        await expect(
            repository.findByFilters({ organizationId: 'org-1' }),
        ).resolves.toEqual([]);
    });
});
