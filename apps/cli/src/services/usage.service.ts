import { CommandError } from '../utils/command-errors.js';
import { cockpitApi, type QueryParams } from './api/cockpit.api.js';
import {
    resolveDateRange,
    resolveTeamRepository,
    type DateRange,
    type DateRangeInput,
} from './cockpit.service.js';
import { userContextService } from './user-context.service.js';

export const USAGE_DIMENSIONS = [
    'daily',
    'pr',
    'developer',
    'review',
    'model',
] as const;

export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export type UsageTokensOptions = DateRangeInput & {
    by?: string;
    repo?: string;
    developer?: string;
    pr?: string | number;
    team?: string;
};

type UsageTotals = { total: number; [key: string]: unknown };
type CostBreakdown = { total: number; [key: string]: unknown };

export type UsageSummary = {
    totals: UsageTotals;
    totalCost: CostBreakdown;
    byModel: Array<Record<string, unknown> & { model: string }>;
};

export type UsageOverview = {
    summary: UsageSummary;
    daily?: Array<Record<string, unknown>>;
    byPr?: Array<Record<string, unknown> & { prNumber?: number }>;
    byArea?: Array<Record<string, unknown>>;
    byTaskArea?: Array<Record<string, unknown>>;
    byTaskModelSpan?: Array<Record<string, unknown>>;
};

export type UsageTokensResult = {
    team: { id: string; name: string };
    range: DateRange;
    filters: {
        repositoryId: string | null;
        developer: string | null;
        prNumber: number | null;
    };
    by: UsageDimension;
    summary: UsageSummary;
    previousPeriod: (DateRange & { cost: number; tokens: number }) | null;
    activeDays: number;
    pullRequests: number;
    rows: Array<Record<string, unknown>>;
    byTaskArea: Array<Record<string, unknown>>;
};

function parseDimension(value: string | undefined): UsageDimension {
    const dimension = (value ?? 'daily').trim().toLowerCase();
    if (!USAGE_DIMENSIONS.includes(dimension as UsageDimension)) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid value for --by: '${value}'. Use one of: ${USAGE_DIMENSIONS.join(', ')}.`,
        );
    }
    return dimension as UsageDimension;
}

function parsePrNumber(value: string | number | undefined): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CommandError(
            'INVALID_INPUT',
            `Invalid value for --pr: '${value}'. Use a pull request number.`,
        );
    }
    return parsed;
}

/**
 * The window of the same length right before the selected one — what the
 * Token Usage page compares its KPI cards against
 * (apps/web/src/features/ee/token-usage/page.tsx).
 */
export function previousWindow(range: DateRange): DateRange {
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    const windowMs = Math.max(0, end.getTime() - start.getTime());
    return {
        startDate: new Date(start.getTime() - windowMs - 1)
            .toISOString()
            .slice(0, 10),
        endDate: new Date(start.getTime() - 1).toISOString().slice(0, 10),
    };
}

class UsageService {
    async getTokens(
        options: UsageTokensOptions = {},
    ): Promise<UsageTokensResult> {
        const by = parseDimension(options.by);
        const prNumber = parsePrNumber(options.pr);
        const range = resolveDateRange(options);
        const context = await userContextService.resolve('Token usage', {
            team: options.team,
        });
        const repository = options.repo
            ? await resolveTeamRepository(context, options.repo)
            : null;
        const developer = options.developer?.trim() || undefined;

        // `byok` is left out on purpose: the API picks the bucket the
        // organization's plan and LLM setup use, as the page does.
        const filters: QueryParams = {
            startDate: range.startDate,
            endDate: range.endDate,
            prNumber,
            developer,
            repositoryId: repository?.id,
            teamId: context.teamId,
        };
        const previous = previousWindow(range);
        const token = context.accessToken;

        const [overview, developerRows, reviewRows, previousOverview] =
            await Promise.all([
                cockpitApi.get<UsageOverview>(
                    token,
                    '/usage/tokens/overview',
                    filters,
                ),
                by === 'developer'
                    ? cockpitApi.get<Array<Record<string, unknown>>>(
                          token,
                          '/usage/tokens/by-developer',
                          filters,
                      )
                    : Promise.resolve(null),
                by === 'review'
                    ? cockpitApi.get<Array<Record<string, unknown>>>(
                          token,
                          '/usage/tokens/by-review',
                          filters,
                      )
                    : Promise.resolve(null),
                cockpitApi
                    .get<UsageOverview>(token, '/usage/tokens/overview', {
                        ...filters,
                        ...previous,
                    })
                    .catch(() => null),
            ]);

        const daily = overview.daily ?? [];
        const byPr = overview.byPr ?? [];
        const rows =
            by === 'pr'
                ? byPr
                : by === 'developer'
                  ? (developerRows ?? [])
                  : by === 'review'
                    ? (reviewRows ?? [])
                    : by === 'model'
                      ? (overview.summary?.byModel ?? [])
                      : daily;

        return {
            team: { id: context.teamId, name: context.teamName },
            range,
            filters: {
                repositoryId: repository?.id ?? null,
                developer: developer ?? null,
                prNumber: prNumber ?? null,
            },
            by,
            summary: overview.summary,
            previousPeriod: previousOverview
                ? {
                      ...previous,
                      cost: previousOverview.summary.totalCost.total,
                      tokens: previousOverview.summary.totals.total,
                  }
                : null,
            activeDays: new Set(daily.map((row) => row.date).filter(Boolean))
                .size,
            pullRequests: new Set(
                byPr
                    .map((row) => row.prNumber)
                    .filter((value) => typeof value === 'number'),
            ).size,
            rows,
            byTaskArea: overview.byTaskArea ?? [],
        };
    }
}

export const usageService = new UsageService();
