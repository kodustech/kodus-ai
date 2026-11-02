import type {
    FormattedPullRequestMessages,
    SavePullRequestMessagesRequest,
    SavePullRequestMessagesResult,
    TeamParameter,
} from '../../types/review-messages.js';
import { buildAuthHeaders, buildQuery } from '../user-context.service.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export const LANGUAGE_CONFIG_KEY = 'language_config';

/**
 * The endpoints behind Settings > Code Review > Custom Messages
 * (apps/web/src/lib/services/pull-request-messages) and the review language
 * the General page saves as its own team parameter.
 */
export class RealReviewMessagesApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    getMessages(
        accessToken: string,
        params: { repositoryId: string; directoryId?: string },
    ): Promise<FormattedPullRequestMessages | null> {
        return this.requester<FormattedPullRequestMessages | null>(
            `/pull-request-messages/find-by-repository-or-directory${buildQuery(params)}`,
            { headers: buildAuthHeaders(accessToken) },
        );
    }

    saveMessages(
        accessToken: string,
        body: SavePullRequestMessagesRequest,
    ): Promise<SavePullRequestMessagesResult> {
        return this.requester<SavePullRequestMessagesResult>(
            '/pull-request-messages',
            {
                method: 'POST',
                headers: buildAuthHeaders(accessToken),
                body: JSON.stringify(body),
            },
        );
    }

    getLanguage(
        accessToken: string,
        teamId: string,
    ): Promise<TeamParameter<string> | null> {
        return this.requester<TeamParameter<string> | null>(
            `/parameters/find-by-key${buildQuery({ key: LANGUAGE_CONFIG_KEY, teamId })}`,
            { headers: buildAuthHeaders(accessToken) },
        );
    }

    setLanguage(
        accessToken: string,
        teamId: string,
        language: string,
    ): Promise<unknown> {
        return this.requester('/parameters/create-or-update', {
            method: 'POST',
            headers: buildAuthHeaders(accessToken),
            body: JSON.stringify({
                key: LANGUAGE_CONFIG_KEY,
                configValue: language,
                organizationAndTeamData: { teamId },
            }),
        });
    }
}

export const reviewMessagesApi = new RealReviewMessagesApi();
