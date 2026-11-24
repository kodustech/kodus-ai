import type { IssueListItem, IssuesFixPrompt } from '../../types/issues.js';
import { requestWithRetry } from './api-core.js';
import type { IIssuesApi } from './api.interface.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

/**
 * The endpoints the web app uses (apps/web/src/lib/services/issues), so a
 * user reads only the issues of repositories the web would show them.
 */
export class RealIssuesApi implements IIssuesApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    private buildAuthHeaders(accessToken: string): Record<string, string> {
        return accessToken.startsWith('kodus_')
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };
    }

    async listIssues(accessToken: string): Promise<IssueListItem[]> {
        return this.requester<IssueListItem[]>('/issues', {
            headers: this.buildAuthHeaders(accessToken),
        });
    }

    async fixPrompt(
        accessToken: string,
        ids: string[],
    ): Promise<IssuesFixPrompt> {
        return this.requester<IssuesFixPrompt>('/issues/fix-prompt', {
            method: 'POST',
            headers: this.buildAuthHeaders(accessToken),
            body: JSON.stringify({ ids }),
        });
    }
}
