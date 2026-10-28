import { BitbucketDataCenterService } from './bitbucket-data-center.service';

it('maps both branch commits on a Data Center pull request', () => {
    const service = new BitbucketDataCenterService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
    const result = (service as any).transformDataCenterPR(
        {
            id: 42,
            state: 'OPEN',
            createdDate: 1,
            updatedDate: 1,
            fromRef: { displayId: 'feature', latestCommit: 'source-tip' },
            toRef: { displayId: 'main', latestCommit: 'target-tip' },
        },
        { organizationId: 'org-1', teamId: 'team-1' },
        { id: 'repo-1', name: 'repo' },
    );

    expect(result.head.sha).toBe('source-tip');
    expect(result.base.sha).toBe('target-tip');
});
