import { useOptionalParameterQuery } from "@services/parameters/hooks";
import { ParametersConfigKey } from "@services/parameters/types";
import { pathToApiUrl } from "src/core/utils/helpers";
import { useFetch, useSuspenseFetch } from "src/core/utils/reactQuery";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";

import type {
    IssueCreationConfigResponse,
    IssueItem,
    IssueListItem,
} from "./types";

// The API leaves `source` out for code review issues. Filling it in gives the
// list filters a value to match on ("code_review" vs "security_scan").
// Module-level so React Query memoizes the selected data across renders.
const withIssueSource = (issues: IssueListItem[]): IssueListItem[] =>
    Array.isArray(issues)
        ? issues.map((issue) =>
              issue.source ? issue : { ...issue, source: "code_review" },
          )
        : issues;

export const useIssues = () => {
    const { organizationId } = useOrganizationContext();

    const { data, ...query } = useFetch<IssueListItem[]>(
        pathToApiUrl("/issues"),
        { params: { organizationId } },
        true,
        {
            placeholderData: (prev) => {
                return prev;
            },
            select: withIssueSource,
        },
    );

    return { ...query, data: data ?? [] };
};

export const useIssue = (
    id: string | null,
    params?: Parameters<typeof useFetch<IssueItem>>[3],
) => {
    return useFetch<IssueItem>(
        id ? pathToApiUrl(`/issues/${id}`) : null,
        undefined,
        true,
        {
            ...params,
            placeholderData: (prev) => prev,
        },
    );
};

export const useSuspenseIssuesCount = () =>
    useSuspenseFetch<number>(
        pathToApiUrl("/issues/count"),
        { params: { status: "open" } },
        { staleTime: 30_000 },
    );

export const useIssueCreationConfig = (teamId: string | undefined) => {
    return useOptionalParameterQuery<
        IssueCreationConfigResponse["configValue"]
    >(ParametersConfigKey.ISSUE_CREATION_CONFIG, teamId, {
        uuid: "",
        configKey: ParametersConfigKey.ISSUE_CREATION_CONFIG,
        configValue: true,
    });
};
