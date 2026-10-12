import { BusinessLogicRecheckService } from './business-logic-recheck.service';

describe('BusinessLogicRecheckService', () => {
    it('gives a run back to the queue when its re-check fails, so the next tick retries it', async () => {
        const run = {
            id: 'run-1',
            organizationId: 'org-1',
            teamId: 'team-1',
            repositoryId: 'repo-1',
            repositoryName: 'notes',
            pullRequestNumber: 47,
        };
        const runs = {
            claimPendingRecheck: jest
                .fn()
                .mockResolvedValueOnce(run)
                .mockResolvedValue(undefined),
            latestForPullRequest: jest.fn(async () => run),
            update: jest.fn(async () => undefined),
        };
        const code = {
            getPullRequest: jest.fn(async () => {
                throw new Error('GitHub is down');
            }),
        };
        const service = new BusinessLogicRecheckService(
            runs as any,
            {} as any,
            {} as any,
            code as any,
        );

        await expect(service.recheckPending()).resolves.toBe(0);
        expect(runs.update).toHaveBeenCalledWith('run-1', {
            pendingRecheck: true,
        });
    });
});
