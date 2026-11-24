import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';

import { ValidationRunRepository } from './validation-run.repository';

describe('ValidationRunRepository.latestPerPullRequest', () => {
    function repositoryReading() {
        const option = jest.fn(function (this: unknown) {
            return this;
        });
        const aggregate = jest.fn(() => ({
            allowDiskUse: () => ({ exec: async () => [], option }),
        }));
        return {
            aggregate,
            option,
            repository: new ValidationRunRepository({ aggregate } as never),
        };
    }

    it('bounds the aggregation so a slow scan is cut off, not left running', async () => {
        const { option, repository } = repositoryReading();
        await repository.latestPerPullRequest('org-1', { from: new Date(0) });
        expect(option).toHaveBeenCalledWith({
            maxTimeMS: MONGO_QUERY_MAX_TIME_MS,
        });
    });

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
