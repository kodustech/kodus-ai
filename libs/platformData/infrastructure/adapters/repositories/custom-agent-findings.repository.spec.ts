import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';

import { PullRequestsRepository } from './pullRequests.repository';

// The custom agents status reads, as they reach the driver.
describe('PullRequestsRepository custom agent findings', () => {
    const scope = {
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        since: new Date('2026-09-17T00:00:00Z'),
    };
    const build = (rows: unknown[][]) => {
        const aggregate = jest.fn();
        rows.forEach((r) =>
            aggregate.mockReturnValueOnce({ toArray: async () => r }),
        );
        const repository = new PullRequestsRepository({
            db: { collection: () => ({ aggregate }) },
        } as any);
        return { repository, aggregate };
    };

    it('reads file and PR-level findings, grouped per agent, PR and statuses', async () => {
        const { repository, aggregate } = build([
            [{ agentId: 'a', prNumber: 7, deliveryStatus: 'sent' }],
            [{ agentId: 'a', prNumber: 8, deliveryStatus: 'sent' }],
        ]);

        await expect(
            repository.findCustomAgentSuggestionRows(scope),
        ).resolves.toEqual([
            { agentId: 'a', prNumber: 7, deliveryStatus: 'sent' },
            { agentId: 'a', prNumber: 8, deliveryStatus: 'sent' },
        ]);

        const [filePipeline] = aggregate.mock.calls[0];
        const [prLevelPipeline] = aggregate.mock.calls[1];
        expect(filePipeline[0].$match).toEqual({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'updatedAt': { $gte: scope.since },
            'files.suggestions.customAgent.id': { $exists: true },
        });
        expect(prLevelPipeline[0].$match).toEqual({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'updatedAt': { $gte: scope.since },
            'prLevelSuggestions.customAgent.id': { $exists: true },
        });
        // Mongo groups the findings per agent, PR and status, so the rows
        // read into memory are bounded by those, not by finding volume.
        expect(filePipeline.find((stage: any) => stage.$group)).toEqual({
            $group: expect.objectContaining({
                _id: {
                    agentId: expect.any(String),
                    prNumber: expect.any(String),
                    deliveryStatus: expect.any(String),
                    priorityStatus: expect.any(String),
                },
                count: { $sum: 1 },
            }),
        });
    });

    it("reads unfollowed citations only from the scope's organization, repository and window", async () => {
        const { repository, aggregate } = build([[]]);

        await repository.findUnfollowedCustomAgentCitations(scope);

        const [pipeline] = aggregate.mock.calls[0];
        expect(pipeline[0].$match).toEqual({
            'organizationId': 'org-1',
            'repository.id': 'repo-1',
            'updatedAt': { $gte: scope.since },
            'files.suggestions.customAgent.id': { $exists: true },
        });
    });

    it('reads every custom agent finding off the primary, bounded, spilling to disk', async () => {
        const { repository, aggregate } = build([[], [], []]);

        await repository.findCustomAgentSuggestionRows(scope);
        await repository.findUnfollowedCustomAgentCitations(scope);

        expect(aggregate).toHaveBeenCalledTimes(3);
        for (const [, options] of aggregate.mock.calls) {
            expect(options.allowDiskUse).toBe(true);
            expect(options.maxTimeMS).toBe(MONGO_QUERY_MAX_TIME_MS);
            expect(options.readPreference.mode).toBe('secondaryPreferred');
            expect(options.readPreference.tags).toEqual([
                { workload: 'analytics' },
                {},
            ]);
        }
    });
});
