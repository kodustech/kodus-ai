import { describe, expect, it, vi } from 'vitest';
import { RealPullRequestsApi } from '../pull-requests.api.js';

describe('RealPullRequestsApi', () => {
    it('reads executions with the params the web PR page sends', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({ data: [] });
        const api = new RealPullRequestsApi(requestWithRetry);

        await api.getExecutions('eyJ.user.token', {
            teamId: 'team-1',
            repositoryName: 'acme/api',
            pullRequestNumber: 42,
            cursor: 'c1',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/pull-requests/executions?teamId=team-1&repositoryName=acme%2Fapi&pullRequestNumber=42&limit=20&cursor=c1',
            { headers: { Authorization: 'Bearer eyJ.user.token' } },
        );
    });

    it('prefers the repository id over the name', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({ data: [] });
        const api = new RealPullRequestsApi(requestWithRetry);

        await api.getExecutions('eyJ.user.token', {
            teamId: 'team-1',
            repositoryId: 'repo-1',
            repositoryName: 'acme/api',
            pullRequestNumber: 42,
            limit: 5,
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/pull-requests/executions?teamId=team-1&repositoryId=repo-1&pullRequestNumber=42&limit=5',
            { headers: { Authorization: 'Bearer eyJ.user.token' } },
        );
    });
});
