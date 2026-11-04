import { buildAuthHeaders, buildQuery } from '../user-context.service.js';
import { requestWithRetry } from './api-core.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export type QueryParams = Record<
    string,
    string | number | boolean | undefined | null
>;

export type TeamRepository = {
    id: string;
    name: string;
    full_name?: string;
    organizationName?: string;
};

/**
 * Reads the endpoints behind the web app's Cockpit and Token Usage pages,
 * with the logged-in user's token so the same RBAC applies.
 */
export class RealCockpitApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    get<T>(accessToken: string, path: string, params: QueryParams): Promise<T> {
        return this.requester<T>(`${path}${buildQuery(params)}`, {
            headers: buildAuthHeaders(accessToken),
        });
    }

    listSelectedRepositories(
        accessToken: string,
        teamId: string,
    ): Promise<TeamRepository[]> {
        return this.get<TeamRepository[]>(
            accessToken,
            '/code-management/repositories/selected',
            { teamId },
        );
    }

    /** The org's Cockpit card/tab switches (Organization > Cockpit). */
    getMetricsVisibility(
        accessToken: string,
    ): Promise<CockpitMetricsVisibility | null> {
        return this.get<CockpitMetricsVisibility | null>(
            accessToken,
            '/organization-parameters/cockpit-metrics-visibility',
            {},
        );
    }
}

export type CockpitMetricsVisibility = {
    tabs?: Partial<Record<'kodusReview' | 'productivity' | 'intent', boolean>>;
    summary?: Partial<Record<string, boolean>>;
    details?: Partial<Record<string, boolean>>;
};

export const cockpitApi = new RealCockpitApi();
