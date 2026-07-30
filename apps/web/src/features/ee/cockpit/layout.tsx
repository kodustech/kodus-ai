import { cookies } from "next/headers";
import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { Page } from "@components/ui/page";
import { TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { getCockpitMetricsVisibility } from "@services/organizationParameters/fetch";
import type { CookieName } from "src/core/utils/cookie";
import { captureGateHit } from "src/core/utils/gate-hit";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { greeting } from "src/core/utils/helpers";

import { validateOrganizationLicense } from "../subscription/_services/billing/fetch";
import { CockpitTabs } from "./_components/cockpit-tabs";
import { CockpitLockedPreview } from "./_components/locked-preview";
import { DateRangePicker } from "./_components/date-range-picker";
import { ExpandableCardsLayout } from "./_components/expandable-cards-layout";
import { CockpitNoDataBanner } from "./_components/no-data-banner";
import { RepositoryPicker } from "./_components/repository-picker";
import { ShareViewButton } from "./_components/share-view-button";
import { tabs, type TabValue } from "./_constants";
import { extractApiData } from "./_helpers/api-data-extractor";
import { isCockpitTierAllowed } from "./_helpers/tier-policy";
import { getAnalyticsStatus } from "./_services/analytics/fetch";

export default async function Layout({
    bugRatioAnalytics,
    deployFrequencyAnalytics,
    kodusReviewTab,
    leadTimeBreakdownChart,
    prCycleTimeAnalytics,
    prCycleTimeChart,
    prsMergedByDeveloperChart,
    prSizeAnalytics,
    prsOpenedVsClosedChart,
    teamActivityChart,
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
    kodusReviewTab: React.ReactNode;
}) {
    // Cockpit availability is decided solely by the license tier below
    // (`isCockpitTierAllowed`). We intentionally do NOT gate on
    // `WEB_ANALYTICS_SECRET`: that env var is the x-api-key for the retired
    // standalone `kodus-service-analytics` microservice, and the backend
    // source resolver now hard-returns INTERNAL — analytics is served by the
    // in-process Postgres warehouse via apps/api (JWT auth), which never reads
    // that secret. Gating the page on an empty legacy secret made self-hosted
    // Enterprise orgs see "Analytics Not Available" despite a valid license.
    const [cookieStore, selectedTeamId] = await Promise.all([
        cookies(),
        getGlobalSelectedTeamId(),
    ]);

    // Kick the license check and the analytics/visibility fetches off together
    // (the license call can be slow — billing cold-start), then await the
    // license first for the tier gate. This hides the analytics latency behind
    // the license round-trip instead of running them in series.
    const licensePromise = validateOrganizationLicense({
        teamId: selectedTeamId,
    }).catch(() => null);
    const analyticsPromise = Promise.all([
        getAnalyticsStatus().catch(() => ({ hasData: false })),
        getCockpitMetricsVisibility(),
    ]);

    const organizationLicense = await licensePromise;

    // Cockpit is scoped to Teams cloud + Enterprise (cloud and
    // self-hosted). Trials count as Teams-cloud. See
    // `libs/cockpit/domain/tier-policy.ts` for the authoritative rule
    // — keep both copies aligned. Below the tier, we show a blurred
    // static preview with an upgrade CTA instead of the screen; none of
    // the analytics fetches below run, and the parallel-route slots are
    // not rendered (their server fetches are rejected by the backend
    // tier policy anyway).
    if (!isCockpitTierAllowed(organizationLicense)) {
        await captureGateHit({
            feature: "cockpit",
            plan: organizationLicense?.subscriptionStatus,
            metadata: { surface: "locked_preview" },
        });

        return (
            <LockedFeatureOverlay
                title="Unlock the Cockpit"
                description="Engineering metrics and Kody review analytics for your team are available on Teams and Enterprise plans."
                cta={{
                    label: "Upgrade plan",
                    href: "/settings/subscription",
                    feature: "cockpit",
                    plan: organizationLicense?.subscriptionStatus,
                    metadata: { surface: "locked_preview" },
                }}>
                <CockpitLockedPreview />
            </LockedFeatureOverlay>
        );
    }

    const [analyticsResult, metricsVisibility] = await analyticsPromise;

    const data = extractApiData(analyticsResult);
    const hasAnalyticsData = data?.hasData;

    const dateRangeCookieValue = cookieStore.get(
        "cockpit-selected-date-range" satisfies CookieName,
    )?.value;

    const repositoryCookieValue = cookieStore.get(
        "cockpit-selected-repository" satisfies CookieName,
    )?.value;

    // Whole-tab visibility. At least one tab is always enabled (the
    // settings form prevents disabling both); fall back defensively.
    const showKodusReview = metricsVisibility.tabs?.kodusReview ?? true;
    const showProductivity = metricsVisibility.tabs?.productivity ?? true;
    const tabsVisibility: Record<TabValue, boolean> = {
        "kodus-review": showKodusReview,
        "productivity": showProductivity || !showKodusReview,
    };
    const defaultTab: TabValue = showKodusReview
        ? "kodus-review"
        : "productivity";

    const visibleTabs = (Object.keys(tabsVisibility) as TabValue[]).filter(
        (tab) => tabsVisibility[tab],
    );

    const entries = Object.entries(tabs);

    return (
        <Page.Root>
            {!hasAnalyticsData && <CockpitNoDataBanner />}

            <Page.Header className="max-w-full px-6">
                <Page.Title>{greeting()}</Page.Title>
                <div className="ml-auto flex items-center gap-2">
                    <RepositoryPicker
                        cookieValue={repositoryCookieValue}
                        teamId={selectedTeamId}
                    />
                    <DateRangePicker cookieValue={dateRangeCookieValue} />
                    <ShareViewButton />
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                <div>
                    <CockpitTabs
                        defaultTab={defaultTab}
                        visibleTabs={visibleTabs}>
                        <TabsList>
                            {/* TODO: add JIRA tab */}
                            {entries.map(([value, name]) => {
                                if (!tabsVisibility[value as TabValue]) {
                                    return;
                                }

                                return (
                                    <TabsTrigger key={value} value={value}>
                                        {name}
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>

                        {tabsVisibility.productivity && (
                            <TabsContent
                                value={"productivity" satisfies TabValue}
                                className="flex flex-col gap-2">
                                <div className="grid grid-cols-4 gap-2 *:h-56">
                                    {metricsVisibility.summary
                                        .deployFrequency && (
                                        <div>{deployFrequencyAnalytics}</div>
                                    )}
                                    {metricsVisibility.summary.prCycleTime && (
                                        <div>{prCycleTimeAnalytics}</div>
                                    )}
                                    {metricsVisibility.summary.bugRatio && (
                                        <div>{bugRatioAnalytics}</div>
                                    )}
                                    {metricsVisibility.summary.prSize && (
                                        <div>{prSizeAnalytics}</div>
                                    )}
                                </div>

                                <div className="relative grid grid-cols-2 gap-2 *:h-[500px]">
                                    <ExpandableCardsLayout>
                                        {metricsVisibility.details
                                            .leadTimeBreakdown &&
                                            leadTimeBreakdownChart}
                                        {metricsVisibility.details
                                            .prCycleTime && prCycleTimeChart}
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
                        )}

                        {tabsVisibility["kodus-review"] && (
                            <TabsContent
                                forceMount
                                value={"kodus-review" satisfies TabValue}
                                className="flex flex-col gap-6">
                                {kodusReviewTab}
                            </TabsContent>
                        )}
                    </CockpitTabs>
                </div>

                {children}
            </Page.Content>
        </Page.Root>
    );
}
