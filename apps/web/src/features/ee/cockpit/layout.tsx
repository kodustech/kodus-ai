import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Page } from "@components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { getCockpitMetricsVisibility } from "@services/organizationParameters/fetch";
import type { CookieName } from "src/core/utils/cookie";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { greeting } from "src/core/utils/helpers";

import { validateOrganizationLicense } from "../subscription/_services/billing/fetch";
import { DateRangePicker } from "./_components/date-range-picker";
import { ExpandableCardsLayout } from "./_components/expandable-cards-layout";
import { CockpitNoDataBanner } from "./_components/no-data-banner";
import { RepositoryPicker } from "./_components/repository-picker";
import { tabs, type TabValue } from "./_constants";
import { extractApiData } from "./_helpers/api-data-extractor";
import { isCockpitTierAllowed } from "./_helpers/tier-policy";
import { getAnalyticsStatus } from "./_services/analytics/fetch";
import { AnalyticsNotAvailable } from "./not-available";

export default async function Layout({
    bugRatioAnalytics,
    codeHealthByCategory,
    codeHealthByRepository,
    deployFrequencyAnalytics,
    flowMetrics,
    leadTimeBreakdownChart,
    prCycleTimeAnalytics,
    prCycleTimeChart,
    prsMergedByDeveloperChart,
    prSizeAnalytics,
    prsOpenedVsClosedChart,
    teamActivityChart,
    kodySuggestionsAnalytics,
    children,
}: React.PropsWithChildren & {
    children: React.ReactNode;
    bugRatioAnalytics: React.ReactNode;
    deployFrequencyAnalytics: React.ReactNode;
    prCycleTimeAnalytics: React.ReactNode;
    prSizeAnalytics: React.ReactNode;
    leadTimeBreakdownChart: React.ReactNode;
    prCycleTimeChart: React.ReactNode;
    prsOpenedVsClosedChart: React.ReactNode;
    prsMergedByDeveloperChart: React.ReactNode;
    teamActivityChart: React.ReactNode;
    codeHealthByCategory: React.ReactNode;
    codeHealthByRepository: React.ReactNode;
    flowMetrics: React.ReactNode;
    kodySuggestionsAnalytics: React.ReactNode;
}) {
    if (!process.env.WEB_ANALYTICS_SECRET) {
        return <AnalyticsNotAvailable />;
    }

    const [cookieStore, selectedTeamId] = await Promise.all([
        cookies(),
        getGlobalSelectedTeamId(),
    ]);

    const organizationLicense = await validateOrganizationLicense({
        teamId: selectedTeamId,
    }).catch(() => null);

    // Cockpit is scoped to Teams cloud + Enterprise (cloud and
    // self-hosted). Trials count as Teams-cloud. See
    // `libs/cockpit/domain/tier-policy.ts` for the authoritative rule
    // — keep both copies aligned.
    if (!isCockpitTierAllowed(organizationLicense)) redirect("/settings/git");

    const [analyticsResult, metricsVisibility] = await Promise.all([
        getAnalyticsStatus().catch(() => ({ hasData: false })),
        getCockpitMetricsVisibility(),
    ]);

    const data = extractApiData(analyticsResult);
    const hasAnalyticsData = data?.hasData;

    const dateRangeCookieValue = cookieStore.get(
        "cockpit-selected-date-range" satisfies CookieName,
    )?.value;

    const repositoryCookieValue = cookieStore.get(
        "cockpit-selected-repository" satisfies CookieName,
    )?.value;

    const entries = Object.entries(tabs);

    return (
        <Page.Root>
            {!hasAnalyticsData && <CockpitNoDataBanner />}

            <Page.Header>
                <Page.Title>{greeting()}</Page.Title>
                <div className="ml-auto">
                    <RepositoryPicker
                        cookieValue={repositoryCookieValue}
                        teamId={selectedTeamId}
                    />
                </div>
            </Page.Header>

            <Page.Content>
                <div className="grid grid-cols-3 grid-rows-2 gap-2 *:h-56">
                    {metricsVisibility.summary.deployFrequency && (
                        <div>{deployFrequencyAnalytics}</div>
                    )}
                    {metricsVisibility.summary.prCycleTime && (
                        <div>{prCycleTimeAnalytics}</div>
                    )}
                    {metricsVisibility.summary.kodySuggestions && (
                        <div>{kodySuggestionsAnalytics}</div>
                    )}
                    {metricsVisibility.summary.bugRatio && (
                        <div>{bugRatioAnalytics}</div>
                    )}
                    {metricsVisibility.summary.prSize && (
                        <div>{prSizeAnalytics}</div>
                    )}
                </div>

                <div className="mt-10">
                    <Tabs defaultValue={"productivity" satisfies TabValue}>
                        <TabsList>
                            {/* TODO: add JIRA tab */}
                            {entries.map(([value, name]) => {
                                if (
                                    value ===
                                    ("flow-metrics" satisfies TabValue)
                                ) {
                                    return;
                                }

                                return (
                                    <TabsTrigger key={value} value={value}>
                                        {name}
                                    </TabsTrigger>
                                );
                            })}
                            <div className="flex flex-1 justify-end">
                                <DateRangePicker
                                    cookieValue={dateRangeCookieValue}
                                />
                            </div>
                        </TabsList>

                        <TabsContent value={"flow-metrics" satisfies TabValue}>
                            {flowMetrics}
                        </TabsContent>

                        <TabsContent
                            forceMount
                            value={"productivity" satisfies TabValue}>
                            <div className="relative grid grid-cols-2 gap-2 *:h-[500px]">
                                <ExpandableCardsLayout>
                                    {metricsVisibility.details
                                        .leadTimeBreakdown &&
                                        leadTimeBreakdownChart}
                                    {metricsVisibility.details.prCycleTime &&
                                        prCycleTimeChart}
                                    {metricsVisibility.details
                                        .prsOpenedVsClosed &&
                                        prsOpenedVsClosedChart}
                                    {metricsVisibility.details
                                        .prsMergedByDeveloper &&
                                        prsMergedByDeveloperChart}
                                </ExpandableCardsLayout>

                                {metricsVisibility.details.teamActivity && (
                                    <div className="col-span-2 h-auto!">
                                        {teamActivityChart}
                                    </div>
                                )}
                            </div>
                        </TabsContent>

                        <TabsContent
                            forceMount
                            value={"code-health" satisfies TabValue}
                            className="flex flex-col gap-6">
                            {codeHealthByCategory}
                            {codeHealthByRepository}
                        </TabsContent>
                    </Tabs>
                </div>

                {children}
            </Page.Content>
        </Page.Root>
    );
}
