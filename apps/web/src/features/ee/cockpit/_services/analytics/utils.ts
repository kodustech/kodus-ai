import { authorizedFetch, typedFetch } from '@services/fetch';
import { getOrganizationId } from '@services/organizations/fetch';
import { createUrl, pathToApiUrl } from 'src/core/utils/helpers';
import { isServerSide } from 'src/core/utils/server-side';

import type { PercentageDiff } from '../../_components/percentage-diff';
import { getSelectedRepository } from '../../_helpers/get-selected-repository';

type CockpitSource = 'internal' | 'legacy-bq';

/**
 * In-memory cache of which backend serves cockpit data per organization.
 * The resolver in apps/api consults a PostHog flag, so the answer can
 * change — but rarely. 5 minutes is a sensible TTL: short enough that
 * a flag flip propagates within a coffee break, long enough to absorb
 * the per-page-render request volume.
 */
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const sourceCache = new Map<
    string,
    { source: CockpitSource; cachedAt: number }
>();

async function resolveCockpitSource(
    organizationId: string,
): Promise<CockpitSource> {
    const cached = sourceCache.get(organizationId);
    if (cached && Date.now() - cached.cachedAt < SOURCE_CACHE_TTL_MS) {
        return cached.source;
    }

    try {
        const url = pathToApiUrl(`/cockpit/source/${organizationId}`);
        const res = await authorizedFetch<{
            organizationId: string;
            source: CockpitSource;
        }>(url);
        sourceCache.set(organizationId, {
            source: res.source,
            cachedAt: Date.now(),
        });
        return res.source;
    } catch (err) {
        // Resolver is opt-in routing; if apps/api is unreachable or the
        // endpoint isn't deployed yet, fall back to legacy so the UI
        // keeps working. Don't cache the failure — retry next call.
        if (err instanceof Error) {
            console.warn(
                `[cockpit] source resolver failed, defaulting to legacy-bq: ${err.message}`,
            );
        }
        return 'legacy-bq';
    }
}

export const analyticsFetch = async <Data>(
    url: `/${string}`,
    options: Parameters<typeof typedFetch>['1'] = {},
) => {
    const [organizationId, selectedRepository] = await Promise.all([
        getOrganizationId(),
        getSelectedRepository(),
    ]);

    const source = await resolveCockpitSource(organizationId);

    const params = {
        ...options.params,
        organizationId,
        ...(selectedRepository && { repository: selectedRepository }),
    };

    if (source === 'internal') {
        // New path: route through apps/api (Postgres analytics warehouse).
        // `authorizedFetch` injects the JWT (cookie or session), and
        // unwraps the apps/api `{ data, statusCode, type }` envelope so
        // the return shape matches the legacy `kodus-service-analytics`
        // payload — consumers stay untouched.
        const finalUrl = pathToApiUrl(url);
        try {
            return await authorizedFetch<Data>(finalUrl, {
                ...options,
                params,
            });
        } catch (error) {
            if (error instanceof Error) {
                console.error(
                    `[cockpit/internal] request failed: ${error.message} in ${finalUrl}`,
                );
                return null as Data;
            }
            throw error;
        }
    }

    // Legacy path — kodus-service-analytics on BigQuery. Kept verbatim
    // for the rollout window; will be removed once the PostHog flag
    // hits 100% and the legacy stack is decommissioned.
    if (!process.env.WEB_ANALYTICS_SECRET) {
        console.warn(
            'WEB_ANALYTICS_SECRET is not configured. Analytics requests will be skipped.',
        );
        return null as Data;
    }

    let hostName = process.env.WEB_ANALYTICS_HOSTNAME;
    const port = process.env.WEB_PORT_ANALYTICS;

    // if 'true' we are in the server and hostname is not a domain
    if (isServerSide && hostName === 'localhost') {
        hostName =
            process.env.GLOBAL_ANALYTICS_CONTAINER_NAME ||
            'kodus-analytics-service';
    }

    // Analytics service is intra-network — http + port, no heuristics.
    const finalUrl = createUrl(`${hostName}`, port, `/api${url}`, {
        internal: true,
    });

    try {
        return await typedFetch<Data>(finalUrl, {
            ...options,
            params,
            headers: {
                ...options?.headers,
                'x-api-key': process.env.WEB_ANALYTICS_SECRET,
            },
        });
    } catch (error) {
        if (error instanceof Error) {
            console.error(
                `Analytics request failed: ${error.message} in ${finalUrl}`,
            );
            return null as Data;
        }
        throw error;
    }
};

/**
 * startDate/endDate: Represents a date string in ISO format (YYYY-MM-DD).
 */
export type AnalyticsParams = {
    startDate: string;
    endDate: string;
};

export const getPercentageDiff = ({
    trend,
}: {
    trend: string;
}): React.ComponentProps<typeof PercentageDiff>['status'] => {
    switch (trend) {
        case 'unchanged':
            return 'neutral';

        case 'improved':
            return 'good';

        case 'worsened':
            return 'bad';

        default:
            return 'neutral';
    }
};
