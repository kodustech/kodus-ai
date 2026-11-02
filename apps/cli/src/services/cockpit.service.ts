import { ApiError } from '../types/errors.js';
import { CommandError } from '../utils/command-errors.js';
import {
    cockpitApi,
    type CockpitMetricsVisibility,
    type QueryParams,
    type TeamRepository,
} from './api/cockpit.api.js';
import {
    userContextService,
    type UserContext,
} from './user-context.service.js';

export const COCKPIT_TABS = [
    'kodus-review',
    'intent',
    'productivity',
    'code-areas',
] as const;

export type CockpitTab = (typeof COCKPIT_TABS)[number];

export type DateRangeInput = {
    from?: string;
    to?: string;
};

export type DateRange = {
    startDate: string;
    endDate: string;
};

export type CockpitOptions = DateRangeInput & {
    repo?: string;
    team?: string;
};

export type CockpitTabResult = {
    tab: CockpitTab;
    team: { id: string; name: string };
    range: DateRange;
    repository: { id: string; fullName: string } | null;
    metrics: Record<string, unknown>;
    // Metrics whose endpoint failed; the web app renders those cards empty.
    errors: Record<string, string>;
    // Metrics the organization turned off in its Cockpit settings; the web
    // app does not render those cards, so they are not fetched.
    hidden: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The Cockpit's default window: the last 15 days, as local calendar dates
// (apps/web/src/features/ee/cockpit/_helpers/get-selected-date-range.ts).
const DEFAULT_RANGE_DAYS = 15;

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function requireIsoDate(value: string, flag: string): string {
    const trimmed = value.trim();
    if (!ISO_DATE.test(trimmed) || Number.isNaN(new Date(trimmed).getTime())) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid value for ${flag}: '${value}'. Use YYYY-MM-DD.`,
        );
    }
    return trimmed;
}

export function resolveDateRange(
    input: DateRangeInput,
    now: Date = new Date(),
    defaultDays: number = DEFAULT_RANGE_DAYS,
): DateRange {
    const endDate = input.to
        ? requireIsoDate(input.to, '--to')
        : formatLocalDate(now);
    let startDate: string;
    if (input.from) {
        startDate = requireIsoDate(input.from, '--from');
    } else {
        const start = new Date(`${endDate}T00:00:00`);
        start.setDate(start.getDate() - defaultDays);
        startDate = formatLocalDate(start);
    }

    if (startDate > endDate) {
        throw new CommandError(
            'INVALID_INPUT',
            `--from (${startDate}) is after --to (${endDate}).`,
        );
    }

    return { startDate, endDate };
}

export function repositoryFullName(repository: TeamRepository): string {
    return (
        repository.full_name ||
        (repository.organizationName
            ? `${repository.organizationName}/${repository.name}`
            : repository.name)
    );
}

export async function resolveTeamRepository(
    context: UserContext,
    reference: string,
): Promise<TeamRepository> {
    const repositories = await cockpitApi.listSelectedRepositories(
        context.accessToken,
        context.teamId,
    );
    const wanted = reference.trim().toLowerCase();
    const match = (repositories ?? []).find(
        (repository) =>
            repository.id.toLowerCase() === wanted ||
            repositoryFullName(repository).toLowerCase() === wanted ||
            repository.name.toLowerCase() === wanted,
    );

    if (!match) {
        throw new CommandError(
            'INVALID_INPUT',
            `Repository '${reference}' is not selected for team '${context.teamName}'.`,
        );
    }

    return match;
}

type MetricRequest = {
    key: string;
    path: string;
    params: QueryParams;
};

function isForbidden(error: unknown): error is ApiError {
    return error instanceof ApiError && error.statusCode === 403;
}

async function fetchMetrics(
    accessToken: string,
    requests: MetricRequest[],
): Promise<Pick<CockpitTabResult, 'metrics' | 'errors'>> {
    const settled = await Promise.allSettled(
        requests.map((request) =>
            cockpitApi.get<unknown>(accessToken, request.path, request.params),
        ),
    );

    // A 403 means the role or the plan has no Cockpit at all (PolicyGuard /
    // CockpitTierGuard), not one broken card.
    const forbidden = settled.find(
        (result): result is PromiseRejectedResult =>
            result.status === 'rejected' && isForbidden(result.reason),
    );
    if (forbidden) {
        throw new CommandError(
            'API_REQUEST_FAILED',
            `Cockpit is not available for this user or plan: ${(forbidden.reason as ApiError).message}`,
            1,
            { statusCode: 403 },
        );
    }

    const metrics: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    settled.forEach((result, index) => {
        const key = requests[index].key;
        if (result.status === 'fulfilled') {
            metrics[key] = result.value ?? null;
            return;
        }
        metrics[key] = null;
        errors[key] =
            result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
    });

    return { metrics, errors };
}

function productivityRequests(params: QueryParams): MetricRequest[] {
    return [
        {
            key: 'deployFrequency',
            path: '/productivity/highlights/deploy-frequency',
            params,
        },
        {
            key: 'prCycleTime',
            path: '/productivity/highlights/lead-time-for-change',
            params,
        },
        {
            key: 'bugRatio',
            path: '/code-health/highlights/bug-ratio',
            params,
        },
        { key: 'prSize', path: '/productivity/highlights/pr-size', params },
        {
            key: 'leadTimeBreakdown',
            path: '/productivity/charts/lead-time-breakdown',
            params,
        },
        {
            key: 'prCycleTimeWeekly',
            path: '/productivity/charts/lead-time-for-change',
            params,
        },
        {
            key: 'prsOpenedVsClosed',
            path: '/productivity/charts/pull-requests-opened-vs-closed',
            params,
        },
        {
            key: 'prsMergedByDeveloper',
            path: '/productivity/charts/pull-requests-by-developer',
            params,
        },
        {
            key: 'teamActivity',
            path: '/productivity/charts/developer-activity',
            params,
        },
    ];
}

function kodusReviewRequests(params: QueryParams): MetricRequest[] {
    const path = (suffix: string) => `/review-analytics/${suffix}`;
    return [
        {
            key: 'implementationRateWeekly',
            path: path('charts/implementation-rate-weekly'),
            params,
        },
        {
            key: 'implementationRateByCategory',
            path: path('charts/implementation-rate-by-category'),
            params,
        },
        {
            key: 'implementationRateBySeverity',
            path: path('charts/implementation-rate-by-severity'),
            params,
        },
        {
            key: 'ignoredCriticals',
            path: path('highlights/ignored-criticals'),
            params,
        },
        {
            key: 'negativeFeedbackByCategory',
            path: path('charts/negative-feedback-by-category'),
            params,
        },
        {
            key: 'negativeFeedbackWeekly',
            path: path('charts/negative-feedback-weekly'),
            params,
        },
        {
            key: 'negativeVoteRate',
            path: path('highlights/negative-vote-rate'),
            params,
        },
        {
            key: 'operationalMetrics',
            path: path('highlights/operational-metrics'),
            params,
        },
        {
            key: 'operationalOutcomesWeekly',
            path: path('charts/operational-outcomes-weekly'),
            params,
        },
        {
            key: 'repositoriesHealth',
            path: path('tables/repositories-health'),
            params,
        },
        {
            key: 'kodyRulesHealth',
            path: path('tables/kody-rules-health'),
            params,
        },
    ];
}

// Productivity card → its switch in the Cockpit visibility settings, as
// apps/web/src/features/ee/cockpit/layout.tsx renders them.
const PRODUCTIVITY_VISIBILITY: Record<string, ['summary' | 'details', string]> =
    {
        deployFrequency: ['summary', 'deployFrequency'],
        prCycleTime: ['summary', 'prCycleTime'],
        bugRatio: ['summary', 'bugRatio'],
        prSize: ['summary', 'prSize'],
        leadTimeBreakdown: ['details', 'leadTimeBreakdown'],
        prCycleTimeWeekly: ['details', 'prCycleTime'],
        prsOpenedVsClosed: ['details', 'prsOpenedVsClosed'],
        prsMergedByDeveloper: ['details', 'prsMergedByDeveloper'],
        teamActivity: ['details', 'teamActivity'],
    };

export function isTabVisible(
    tab: CockpitTab,
    visibility: CockpitMetricsVisibility | null,
): boolean {
    const showKodusReview = visibility?.tabs?.kodusReview ?? true;
    switch (tab) {
        case 'kodus-review':
            return showKodusReview;
        case 'intent':
            return visibility?.tabs?.intent ?? true;
        case 'productivity':
            // At least one tab always shows; the web falls back to this one.
            return (visibility?.tabs?.productivity ?? true) || !showKodusReview;
        default:
            return true;
    }
}

export function isMetricVisible(
    tab: CockpitTab,
    key: string,
    visibility: CockpitMetricsVisibility | null,
): boolean {
    if (tab !== 'productivity') {
        return true;
    }
    const entry = PRODUCTIVITY_VISIBILITY[key];
    if (!entry) {
        return true;
    }
    const [group, flag] = entry;
    return visibility?.[group]?.[flag] ?? true;
}

class CockpitService {
    async getTab(
        tab: CockpitTab,
        options: CockpitOptions = {},
    ): Promise<CockpitTabResult> {
        if (!COCKPIT_TABS.includes(tab)) {
            throw new CommandError(
                'INVALID_INPUT',
                `Unknown cockpit tab '${tab}'. Use one of: ${COCKPIT_TABS.join(', ')}.`,
            );
        }

        const range = resolveDateRange(options);
        const context = await userContextService.resolve('Cockpit', {
            team: options.team,
        });

        const visibility = await cockpitApi
            .getMetricsVisibility(context.accessToken)
            // Unset or unreadable: the web shows everything. A 403 here also
            // comes back on the metric requests, which report it.
            .catch(() => null);
        if (!isTabVisible(tab, visibility)) {
            throw new CommandError(
                'INVALID_INPUT',
                `The '${tab}' tab is turned off in this organization's Cockpit settings.`,
            );
        }

        let repository: TeamRepository | null = options.repo
            ? await resolveTeamRepository(context, options.repo)
            : null;

        // The Code hotspots tab always maps one repository: the Cockpit's
        // selected one, else the team's first.
        if (tab === 'code-areas' && !repository) {
            const repositories = await cockpitApi.listSelectedRepositories(
                context.accessToken,
                context.teamId,
            );
            repository = repositories?.[0] ?? null;
            if (!repository) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `Team '${context.teamName}' has no repositories selected.`,
                );
            }
        }

        const fullName = repository
            ? repositoryFullName(repository)
            : undefined;
        const analyticsParams: QueryParams = {
            organizationId: context.organizationId,
            startDate: range.startDate,
            endDate: range.endDate,
            repository: fullName,
        };

        const requests: MetricRequest[] =
            tab === 'productivity'
                ? productivityRequests(analyticsParams)
                : tab === 'kodus-review'
                  ? kodusReviewRequests(analyticsParams)
                  : tab === 'intent'
                    ? [
                          {
                              key: 'intent',
                              path: '/business-logic/intent',
                              params: {
                                  startDate: range.startDate,
                                  endDate: range.endDate,
                                  teamId: context.teamId,
                                  repository: fullName,
                              },
                          },
                      ]
                    : [
                          {
                              key: 'areaRiskMap',
                              path: '/code-management/area-risk-map',
                              params: {
                                  repositoryId: repository?.id,
                                  teamId: context.teamId,
                              },
                          },
                      ];

        const hidden = requests
            .filter((request) => !isMetricVisible(tab, request.key, visibility))
            .map((request) => request.key);
        const { metrics, errors } = await fetchMetrics(
            context.accessToken,
            requests.filter((request) => !hidden.includes(request.key)),
        );

        return {
            tab,
            team: { id: context.teamId, name: context.teamName },
            range,
            repository:
                repository && fullName ? { id: repository.id, fullName } : null,
            metrics,
            errors,
            hidden,
        };
    }
}

export const cockpitService = new CockpitService();
