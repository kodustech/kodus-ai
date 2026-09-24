import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { LockedFeatureUnlocks } from "@components/system/locked-feature-unlocks";
import { LockedPagePreview } from "@components/system/locked-page-preview";
import {
    availabilityLine,
    planCtaTarget,
} from "@components/system/plan-cta-target";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Page } from "@components/ui/page";
import { captureGateHit } from "src/core/utils/gate-hit";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { validateOrganizationLicense } from "../../subscription/_services/billing/fetch";
import { isCockpitTierAllowed } from "../_helpers/tier-policy";

import { getSelectedDateRange } from "../_helpers/get-selected-date-range";
import { searchSuggestions } from "../_services/analytics/review/explorer-fetch";
import { ExplorerFilters } from "./_components/explorer-filters";
import { Pagination } from "./_components/pagination";
import { SuggestionsTable } from "./_components/suggestions-table";

export type ExplorerSearchParams = {
    repository?: string;
    category?: string;
    severity?: string;
    ruleId?: string;
    ruleTitle?: string;
    implementationStatus?: string;
    search?: string;
    page?: string;
};

export default async function ReviewSuggestionsPage({
    searchParams,
}: {
    searchParams: Promise<ExplorerSearchParams>;
}) {
    // searchParams and the date range are independent — resolve in parallel.
    const [params, { startDate, endDate }] = await Promise.all([
        searchParams,
        getSelectedDateRange(),
    ]);

    // This is a Cockpit screen reachable by its own URL, so it needs the
    // Cockpit's gate. Without it the analytics call 403s for an org below
    // the tier and the page throws into the error boundary — "Something
    // went wrong" for something that is working exactly as designed.
    const license = await validateOrganizationLicense({
        teamId: await getGlobalSelectedTeamId(),
    }).catch(() => null);

    if (!isCockpitTierAllowed(license)) {
        await captureGateHit({
            feature: "cockpit",
            surface: "locked_preview",
            planType: license?.planType,
            subscriptionStatus: license?.subscriptionStatus,
            metadata: { screen: "review_suggestions" },
        });

        return (
            <LockedFeatureOverlay
                title="Unlock suggestion history"
                description={availabilityLine()}
                details={
                    <LockedFeatureUnlocks
                        items={[
                            "Every suggestion Kody sent, searchable by rule, file and severity",
                            "Which ones were implemented, and which were dismissed",
                            "Filter by repository, category and date range",
                        ]}
                    />
                }
                cta={{
                    ...planCtaTarget(),
                    feature: "cockpit",
                    surface: "locked_preview",
                    planType: license?.planType,
                    subscriptionStatus: license?.subscriptionStatus,
                    metadata: { screen: "review_suggestions" },
                }}>
                <LockedPagePreview title="Suggestions" rows={4} />
            </LockedFeatureOverlay>
        );
    }

    const result = await searchSuggestions({
        startDate,
        endDate,
        repository: params.repository,
        category: params.category,
        severity: params.severity,
        ruleId: params.ruleId,
        implementationStatus: params.implementationStatus,
        search: params.search,
        page: params.page ? Number(params.page) : undefined,
    });

    const implemented = result.items.filter(
        (i) =>
            i.implementationStatus === "implemented" ||
            i.implementationStatus === "partially_implemented",
    ).length;

    return (
        <Page.Root>
            <Page.Header>
                <Breadcrumb>
                    <BreadcrumbList>
                        <BreadcrumbItem>
                            <BreadcrumbLink href="/cockpit">
                                Cockpit
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                            <BreadcrumbPage>Suggestions</BreadcrumbPage>
                        </BreadcrumbItem>
                    </BreadcrumbList>
                </Breadcrumb>
            </Page.Header>

            <Page.Header>
                <Page.Title>Suggestions</Page.Title>
                <span className="text-text-tertiary ml-auto text-xs">
                    {startDate} → {endDate} (cockpit date range)
                </span>
            </Page.Header>

            <Page.Content>
                <ExplorerFilters params={params} />

                <div className="text-text-secondary flex gap-5 px-1 text-sm">
                    <span>
                        <strong className="text-text-primary">
                            {result.total}
                        </strong>{" "}
                        suggestions
                    </span>
                    <span className="text-success">
                        {implemented} implemented on this page
                    </span>
                </div>

                <SuggestionsTable items={result.items} />

                <Pagination
                    total={result.total}
                    page={result.page}
                    pageSize={result.pageSize}
                />
            </Page.Content>
        </Page.Root>
    );
}
