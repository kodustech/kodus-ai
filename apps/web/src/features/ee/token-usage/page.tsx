import { cookies } from "next/headers";
import { Page } from "@components/ui/page";
import {
    getTokenPricingBatch,
    getTokenUsageByDeveloper,
    getTokenUsageByReview,
    getTokenUsageOverview,
} from "@services/usage/fetch";
import {
    BaseUsageContract,
    ModelPricingInfo,
    UsageByAreaResultContract,
    UsageByPrResultContract,
    UsageSummaryContract,
} from "@services/usage/types";
import { CookieName } from "src/core/utils/cookie";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { isBYOKSubscriptionPlan } from "src/features/ee/byok/_utils";
import { getSelectedDateRange } from "src/features/ee/cockpit/_helpers/get-selected-date-range";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";
import { fetchModelPricingFromModelsDev } from "src/features/ee/subscription/choose-plan/_services/models";

import { TokenUsagePageClient } from "./_components/page.client";

function buildFallbackPricing(
    model: string,
    prompt: number,
    completion: number,
): ModelPricingInfo {
    return {
        id: model,
        pricing: {
            input: { default: prompt },
            output: { default: completion },
            cacheRead: { default: 0 },
            cacheWrite: { default: 0 },
            prompt,
            completion,
            // Reasoning is already counted inside outputTokens for every
            // provider we ship; the scalar stays for backward compat only.
            internal_reasoning: completion,
        },
    };
}

function hasPricing(info?: ModelPricingInfo): boolean {
    return !!info && (info.pricing?.prompt > 0 || info.pricing?.completion > 0);
}

/**
 * Fallback for a model absent (or zero-priced) in the LiteLLM catalog: try
 * models.dev, else zero. The catalog itself is resolved in one batch call
 * (getTokenPricingBatch) — this only runs for the leftover misses.
 */
async function resolvePricingFallback(
    model: string,
): Promise<ModelPricingInfo> {
    const modelsDevPricing = await fetchModelPricingFromModelsDev(model);
    if (modelsDevPricing) {
        return buildFallbackPricing(
            model,
            modelsDevPricing.prompt,
            modelsDevPricing.completion,
        );
    }
    return buildFallbackPricing(model, 0, 0);
}

export default async function TokenUsagePage({
    searchParams,
}: {
    searchParams: { [key: string]: string | string[] | undefined };
}) {
    // searchParams, teamId, cookies and the date range are mutually independent
    // — fetch them in one parallel wave instead of four serial round-trips.
    // Only the license check depends on teamId, so it awaits after.
    const [params, teamId, cookieStore, selectedDateRange] = await Promise.all([
        searchParams,
        getGlobalSelectedTeamId(),
        cookies(),
        getSelectedDateRange(),
    ]);

    const subscription = await validateOrganizationLicense({ teamId }).catch(
        () => null,
    );

    const isBYOK = subscription ? isBYOKSubscriptionPlan(subscription) : false;
    const isTrial = subscription?.subscriptionStatus === "trial";

    const filters = {
        startDate: selectedDateRange.startDate,
        endDate: selectedDateRange.endDate,
        prNumber: params.prNumber ? Number(params.prNumber) : undefined,
        developer: params.developer,
        repositoryId:
            typeof params.repositoryId === "string"
                ? params.repositoryId
                : undefined,
        byok: isBYOK,
    };

    // Same-length window immediately before the selected one — powers the
    // "vs previous period" deltas on the KPI cards. Served from the overview
    // cache when warm; a failure only hides the deltas.
    const rangeStart = new Date(selectedDateRange.startDate);
    const rangeEnd = new Date(selectedDateRange.endDate);
    const windowMs = Math.max(0, rangeEnd.getTime() - rangeStart.getTime());
    const previousFilters = {
        ...filters,
        startDate: new Date(rangeStart.getTime() - windowMs - 1)
            .toISOString()
            .slice(0, 10),
        endDate: new Date(rangeStart.getTime() - 1).toISOString().slice(0, 10),
    };

    let data: BaseUsageContract[] = [];
    let summary: UsageSummaryContract | null = null;
    let activeDayCount = 0;
    let uniquePrCount = 0;
    const filterType = params.filter ?? "daily";

    // Primary data fetch — deliberately NOT wrapped in try/catch: a failure
    // here must surface the route error boundary (error.tsx) so the user gets a
    // real "failed to load + retry" instead of a page full of misleading zeros.
    // Pricing has its own catch below and degrades gracefully.
    //
    // ONE covered aggregation returns summary + daily + by-pr (the cost cards
    // need day/PR counts regardless of the chart dimension). Only the
    // by-developer dimension isn't part of it, so that mode fetches alongside.
    // Developer picker options: the by-developer aggregation WITHOUT a
    // developer scope returns one row per developer, i.e. the full roster.
    // Fetch it whenever the developer dimension is active so the combobox
    // keeps every name even after one is selected (a scoped fetch collapses
    // to a single developer). Cache-shared with the view fetch when no
    // developer is selected (identical key), so it's usually free.
    const developerListFilters = { ...filters, developer: undefined };
    const [
        overview,
        developerData,
        developerOptionsData,
        reviewData,
        previousOverview,
    ] = await Promise.all([
        getTokenUsageOverview(filters),
        filterType === "by-developer"
            ? getTokenUsageByDeveloper(filters)
            : Promise.resolve(null),
        filterType === "by-developer"
            ? getTokenUsageByDeveloper(developerListFilters).catch(() => null)
            : Promise.resolve(null),
        filterType === "by-review"
            ? getTokenUsageByReview(filters)
            : Promise.resolve(null),
        getTokenUsageOverview(previousFilters).catch(() => null),
    ]);

    const developerOptions = [
        ...new Set(
            (developerOptionsData ?? [])
                .map((d) => d.developer)
                .filter((d): d is string => !!d),
        ),
    ].sort((a, b) => a.localeCompare(b));

    const previousTotals = previousOverview
        ? {
              cost: previousOverview.summary.totalCost.total,
              tokens: previousOverview.summary.totals.total,
          }
        : null;

    summary = overview.summary;

    const dailyRows = overview.daily ?? [];
    const prRows = overview.byPr ?? [];
    const byArea: UsageByAreaResultContract[] = overview.byArea ?? [];

    // One review run = one correlationId. Keep the FULL id in the key so two
    // runs on the same PR never collide into one bar/row; the chart axis and
    // the table truncate it for display (tooltip shows the full value).
    const reviewRows = (reviewData ?? []).map((r) => ({
        ...r,
        review: `${r.prNumber != null ? `#${r.prNumber} · ` : ""}${r.review}`,
    }));

    data =
        filterType === "by-pr"
            ? prRows
            : filterType === "by-developer"
              ? (developerData ?? [])
              : filterType === "by-review"
                ? reviewRows
                : dailyRows;

    activeDayCount = new Set(dailyRows.map((r) => r.date).filter(Boolean)).size;
    uniquePrCount = new Set(
        prRows
            .map((r) => r.prNumber)
            .filter((n): n is number => typeof n === "number"),
    ).size;

    const ENABLE_MOCK_DATA = false;

    if (ENABLE_MOCK_DATA && filterType === "by-pr") {
        const mockData: UsageByPrResultContract[] = [];

        for (let i = 1; i <= 30; i++) {
            const isOutlier = i === 15;
            const isHighUsage = i === 5 || i === 22;

            const baseInput = isOutlier
                ? 15000000
                : isHighUsage
                  ? 50000
                  : Math.random() * 5000 + 1000;
            const baseOutput = isOutlier
                ? 8000000
                : isHighUsage
                  ? 30000
                  : Math.random() * 3000 + 500;
            const baseReasoning = isOutlier
                ? 2000000
                : isHighUsage
                  ? 10000
                  : Math.random() * 1000 + 200;

            const input = Math.floor(baseInput);
            const output = Math.floor(baseOutput);
            const outputReasoning = Math.floor(baseReasoning);

            mockData.push({
                model: "claude-3-5-sonnet-20241022",
                input,
                output,
                outputReasoning,
                total: input + output + outputReasoning,
                prNumber: i,
            });
        }

        data = mockData;
    }

    const uniqueModels: string[] = Array.from(
        new Set(data.map((d) => d.model)),
    );

    let pricing = {};

    if (ENABLE_MOCK_DATA && filterType === "by-pr") {
        pricing = {
            "claude-3-5-sonnet-20241022": buildFallbackPricing(
                "claude-3-5-sonnet-20241022",
                3.0,
                15.0,
            ),
        };
    } else if (uniqueModels.length) {
        try {
            // ONE batch request for the LiteLLM catalog rates (was N per-model
            // calls). Only models missing/zero in the catalog fall back to
            // models.dev, in parallel.
            const catalogPricing = await getTokenPricingBatch(uniqueModels);
            const entries = await Promise.all(
                uniqueModels.map(async (model) => {
                    const info = catalogPricing[model];
                    return [
                        model,
                        hasPricing(info)
                            ? info
                            : await resolvePricingFallback(model),
                    ] as const;
                }),
            );
            pricing = Object.fromEntries(entries);
        } catch (error) {
            console.error("Failed to fetch pricing data:", error);
        }
    }

    const dateRangeCookieValue = cookieStore.get(
        "cockpit-selected-date-range" satisfies CookieName,
    )?.value;

    return (
        <Page.Root>
            {/* Full-width like the cockpit (its layout uses the same
                max-w-full px-6 on header + content). */}
            <Page.Header className="max-w-full px-6">
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>
            <Page.Content className="max-w-full px-6">
                <TokenUsagePageClient
                    data={data}
                    byArea={byArea}
                    reviewRows={reviewData ?? []}
                    previousTotals={previousTotals}
                    summary={summary}
                    activeDayCount={activeDayCount}
                    uniquePrCount={uniquePrCount}
                    cookieValue={dateRangeCookieValue}
                    models={uniqueModels}
                    developers={developerOptions}
                    teamId={teamId}
                    pricing={pricing}
                />
            </Page.Content>
        </Page.Root>
    );
}
