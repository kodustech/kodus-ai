import { authorizedFetch } from "@services/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

// The explorer talks straight to apps/api (its endpoints only exist on
// the internal warehouse) and manages its own repository filter via URL
// params — so it intentionally bypasses `analyticsFetch`, which would
// inject the cockpit's repository cookie on top.

export type SuggestionsExplorerItem = {
    suggestionId: string;
    repository: string | null;
    repositoryId: string | null;
    filePath: string | null;
    category: string | null;
    severity: string | null;
    implementationStatus: string | null;
    summary: string | null;
    existingCode: string | null;
    improvedCode: string | null;
    language: string | null;
    pullRequestId: string;
    prNumber: number | null;
    commentId: number | null;
    createdAt: string | null;
};

export type SuggestionsExplorerResult = {
    total: number;
    page: number;
    pageSize: number;
    items: SuggestionsExplorerItem[];
};

export type SuggestionsExplorerFilters = {
    startDate: string;
    endDate: string;
    repository?: string;
    category?: string;
    severity?: string;
    ruleId?: string;
    implementationStatus?: string;
    search?: string;
    page?: number;
};

export const searchSuggestions = async (
    filters: SuggestionsExplorerFilters,
): Promise<SuggestionsExplorerResult> => {
    const organizationId = await getOrganizationId();

    const params = Object.fromEntries(
        Object.entries({ ...filters, organizationId }).filter(
            ([, value]) => value !== undefined && value !== "",
        ),
    );

    return authorizedFetch<SuggestionsExplorerResult>(
        pathToApiUrl("/review-analytics/suggestions"),
        { params },
    );
};
