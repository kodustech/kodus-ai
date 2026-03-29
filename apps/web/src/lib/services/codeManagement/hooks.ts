import { useFetch, useSuspenseFetch } from "src/core/utils/reactQuery";

import {
    CODE_MANAGEMENT_API_PATHS,
    type Repository,
    type RepositoryMinimal,
} from "./types";

export function useGetRepositories(
    teamId: string,
    organizationSelected?: any,
    filters?: { isSelected?: boolean },
) {
    return useFetch<Repository[]>(
        CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG,
        {
            params: { teamId, organizationSelected, ...(filters || {}) },
        },
    );
}

export function useGetSelectedRepositories(teamId: string) {
    return useFetch<RepositoryMinimal[]>(
        CODE_MANAGEMENT_API_PATHS.GET_SELECTED_REPOSITORIES,
        { params: { teamId } },
    );
}

export function useSuspenseGetOnboardingPullRequests(teamId: string) {
    const rawData = useSuspenseFetch<
        {
            id: string;
            pull_number: number;
            repository: {
                id: string;
                name: string;
            };
            title: string;
            url: string;
            lastActivityAt?: string;
        }[]
    >(CODE_MANAGEMENT_API_PATHS.GET_ONBOARDING_PULL_REQUESTS, {
        params: { teamId },
    });

    // Transform to legacy format for compatibility
    return rawData.map((pr) => ({
        id: pr.id,
        pull_number: pr.pull_number,
        repository: pr.repository.name, // Extract name from repository object
        repositoryId: pr.repository.id,
        title: pr.title,
        url: pr.url,
        lastActivityAt: pr.lastActivityAt,
    }));
}

export function useSearchPullRequests(
    teamId: string,
    searchParams: {
        number?: string;
        title?: string;
        repositoryId?: string;
    } = {},
) {
    return useFetch<
        {
            id: string;
            pull_number: number;
            repository: {
                id: string;
                name: string;
            };
            title: string;
            url: string;
            lastActivityAt?: string;
        }[]
    >(
        CODE_MANAGEMENT_API_PATHS.GET_ONBOARDING_PULL_REQUESTS,
        {
            params: {
                teamId,
                ...searchParams,
            },
        },
        true, // Always enabled
        {
            refetchOnWindowFocus: false,
            staleTime: 30000,
        },
    );
}

export { useDebouncedPRSearch } from "./hooks/use-debounced-pr-search";
