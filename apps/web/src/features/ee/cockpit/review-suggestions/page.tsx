import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Page } from "@components/ui/page";

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
            <Page.Header className="max-w-full px-6">
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

            <Page.Header className="max-w-full px-6">
                <Page.Title>Suggestions</Page.Title>
                <span className="text-text-tertiary ml-auto text-xs">
                    {startDate} → {endDate} (cockpit date range)
                </span>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
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
