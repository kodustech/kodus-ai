import type {
    PullRequestExecutionsPage,
    PullRequestExecutionsQuery,
} from '../../types/pr-reviews.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export class RealPullRequestsApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    /** Same endpoint and params the web PR page uses (useInfinitePullRequestExecutions). */
    async getExecutions(
        accessToken: string,
        query: PullRequestExecutionsQuery,
    ): Promise<PullRequestExecutionsPage> {
        const params = new URLSearchParams();
        params.set('teamId', query.teamId);
        if (query.repositoryId) {
            params.set('repositoryId', query.repositoryId);
        } else if (query.repositoryName) {
            params.set('repositoryName', query.repositoryName);
        }
        params.set('pullRequestNumber', String(query.pullRequestNumber));
        params.set('limit', String(query.limit ?? 20));
        if (query.cursor) {
            params.set('cursor', query.cursor);
        }

        return this.requester<PullRequestExecutionsPage>(
            `/pull-requests/executions?${params.toString()}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
    }
}

export const pullRequestsApi = new RealPullRequestsApi();
