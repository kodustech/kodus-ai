import type {
    CentralizedPrResult,
    CustomAgentResolveReport,
    CustomAgentsStatus,
    FormattedCodeReviewParameter,
    ResolveCustomAgentRequest,
    SaveCustomAgentsRequest,
    TryCustomAgentRequest,
    TryRunView,
} from '../../types/custom-agents.js';
import { buildAuthHeaders, buildQuery } from '../user-context.service.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

/**
 * The endpoints the web app's custom agents pages call
 * (apps/web/src/lib/services/custom-agents/fetch.ts and
 * apps/web/src/lib/services/parameters/fetch.ts), with the user's token.
 */
export class RealCustomAgentsApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    getCodeReviewConfig(
        accessToken: string,
        teamId: string,
    ): Promise<FormattedCodeReviewParameter> {
        return this.requester<FormattedCodeReviewParameter>(
            `/parameters/code-review-parameter${buildQuery({ teamId })}`,
            { headers: buildAuthHeaders(accessToken) },
        );
    }

    save(
        accessToken: string,
        body: SaveCustomAgentsRequest,
    ): Promise<CentralizedPrResult | Record<string, unknown> | boolean> {
        return this.requester('/parameters/create-or-update-code-review', {
            method: 'POST',
            headers: buildAuthHeaders(accessToken),
            body: JSON.stringify(body),
        });
    }

    getStatus(
        accessToken: string,
        params: { teamId: string; repositoryId: string },
    ): Promise<CustomAgentsStatus> {
        return this.requester<CustomAgentsStatus>(
            `/code-review/custom-agents/status${buildQuery(params)}`,
            { headers: buildAuthHeaders(accessToken) },
        );
    }

    /** Reads skills and docs on the repository's default branch, as the Skills & docs page does. */
    resolve(
        accessToken: string,
        body: ResolveCustomAgentRequest,
    ): Promise<CustomAgentResolveReport> {
        return this.requester<CustomAgentResolveReport>(
            '/code-review/custom-agents/resolve',
            {
                method: 'POST',
                headers: buildAuthHeaders(accessToken),
                body: JSON.stringify(body),
            },
        );
    }

    startTry(
        accessToken: string,
        body: TryCustomAgentRequest,
    ): Promise<TryRunView> {
        return this.requester<TryRunView>('/code-review/custom-agents/try', {
            method: 'POST',
            headers: buildAuthHeaders(accessToken),
            body: JSON.stringify(body),
        });
    }

    readTry(
        accessToken: string,
        runId: string,
        params: { teamId: string; repositoryId: string },
    ): Promise<TryRunView> {
        return this.requester<TryRunView>(
            `/code-review/custom-agents/try/${encodeURIComponent(runId)}${buildQuery(params)}`,
            { headers: buildAuthHeaders(accessToken) },
        );
    }
}

export const customAgentsApi = new RealCustomAgentsApi();
