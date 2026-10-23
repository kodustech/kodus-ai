import { ValidationRunRepository } from './validation-run.repository';

describe('ValidationRunRepository.latestPerPullRequest', () => {
    function repositoryReading() {
        const aggregate = jest.fn(() => ({
            allowDiskUse: () => ({ exec: async () => [] }),
        }));
        return {
            aggregate,
            repository: new ValidationRunRepository({ aggregate } as never),
        };
    }

    it("keeps the reader's repository scope", async () => {
        const { aggregate, repository } = repositoryReading();
        await repository.latestPerPullRequest(
            'org-1',
            { from: new Date(0) },
            { repositoryIds: ['repo-a'] },
        );
        const [pipeline] = aggregate.mock.calls[0] as unknown as [
            Array<{ $match?: Record<string, unknown> }>,
        ];
        expect(pipeline[0].$match).toMatchObject({
            organizationId: 'org-1',
            repositoryId: { $in: ['repo-a'] },
        });
    });

    it('reads only runs of a PR when no scope narrows it', async () => {
        const { aggregate, repository } = repositoryReading();
        await repository.latestPerPullRequest('org-1', { from: new Date(0) });
        const [pipeline] = aggregate.mock.calls[0] as unknown as [
            Array<{ $match?: Record<string, unknown> }>,
        ];
        expect(pipeline[0].$match).toMatchObject({
            repositoryId: { $exists: true, $ne: null },
        });
    });
});
