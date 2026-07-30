import {
    MutationFunction,
    useMutation,
    UseMutationResult,
    useQuery,
    useQueryClient,
    UseQueryOptions,
    useSuspenseQueries,
    useSuspenseQuery,
    type UseSuspenseQueryOptions,
} from "@tanstack/react-query";
import { AxiosError, AxiosRequestConfig } from "axios";

import { useAuth } from "../providers/auth.provider";
import {
    buildAuthorizedSuspenseQueryFn,
    type SuspenseFetchParams,
} from "./authorized-fetch";
import { axiosAuthorized } from "./axios";

/**
 * Suspense-enabled data fetching hook
 *
 * Error handling strategy:
 * - Network/parse errors: use fallbackData if available, otherwise throw
 * - 404 (Not Found): use fallbackData if available (resource doesn't exist yet)
 * - Other API errors (400, 500, etc): always throw - show error to user
 *
 * Errors should be caught by an ErrorBoundary (use PageBoundary).
 *
 * @example
 * <PageBoundary>
 *   <MyComponent />
 * </PageBoundary>
 *
 * function MyComponent() {
 *   const data = useSuspenseFetch<User>('/api/user', {}, {
 *     fallbackData: { name: 'Guest' } // Used for network errors or 404
 *   });
 *   return <div>{data.name}</div>;
 * }
 */
export const useSuspenseFetch = <T>(
    url: string | null,
    params?: SuspenseFetchParams,
    config?: Omit<UseSuspenseQueryOptions<T, Error>, "queryKey"> & {
        /** Used for network errors, parse errors, and 404 (resource not found) */
        fallbackData?: T;
    },
) => {
    const queryKey = generateQueryKey(url!, params);
    const { accessToken } = useAuth();

    const context = useSuspenseQuery<T, Error>({
        ...config,
        queryKey,
        queryFn: buildAuthorizedSuspenseQueryFn<T>(
            url!,
            params,
            accessToken,
            config?.fallbackData,
        ),
    });

    return context.data;
};

/**
 * Suspense fetch for N requests that should run IN PARALLEL. Plain
 * back-to-back `useSuspenseFetch` calls waterfall — the component suspends on
 * the first before the second's hook runs, so request 2 only starts once
 * request 1 resolves. `useSuspenseQueries` starts them all together and
 * suspends until every one settles, so wall-clock = slowest request, not the
 * sum. Each entry's `queryKey` matches `useSuspenseFetch`, so results are
 * shared with (and seeded by) the single-fetch cache.
 */
export const useSuspenseFetchMany = <T extends readonly unknown[]>(requests: {
    [K in keyof T]: {
        url: string;
        params?: SuspenseFetchParams;
        fallbackData?: T[K];
    };
}): T => {
    const { accessToken } = useAuth();

    const results = useSuspenseQueries({
        queries: requests.map((request) => ({
            queryKey: generateQueryKey(request.url, request.params),
            queryFn: buildAuthorizedSuspenseQueryFn(
                request.url,
                request.params,
                accessToken,
                request.fallbackData,
            ),
        })),
    });

    return results.map((result) => result.data) as unknown as T;
};

/**
 * Standard data fetching hook (non-suspense)
 *
 * Returns loading/error states that should be handled by the component.
 * Uses global retry configuration from QueryProvider.
 */
export const useFetch = <T>(
    url: string | null,
    params?: AxiosRequestConfig<any>,
    enabledCondition?: boolean,
    config?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">,
): ReturnType<typeof useQuery<T, Error>> => {
    const queryKey = generateQueryKey(url!, params);

    const context = useQuery<T, Error>({
        queryKey,
        queryFn: ({ signal }) => {
            const axiosConfig: AxiosRequestConfig<any> = {
                ...params,
                signal,
            };

            return axiosAuthorized
                .fetcher<T>(url!, axiosConfig)
                .then((res: { data: any }) => res.data);
        },
        enabled: !!url && enabledCondition,
        ...config,
    });

    return context;
};

const useGenericMutation = <T, S>(
    func: MutationFunction<S, S>,
    url: string,
    params?: AxiosRequestConfig<any>,
    updater?: (oldData: T | undefined, newData: S) => T,
): UseMutationResult<
    S,
    AxiosError<unknown, any>,
    S,
    { previousData: T | undefined }
> => {
    const queryClient = useQueryClient();

    const queryKey = generateQueryKey(url, params);

    return useMutation<
        S,
        AxiosError<unknown, any>,
        S,
        { previousData: T | undefined }
    >({
        mutationFn: func,
        onMutate: async (variables: S) => {
            await queryClient.cancelQueries({ queryKey });

            const previousData = queryClient.getQueryData<T>(queryKey);

            if (updater && previousData !== undefined) {
                queryClient.setQueryData<T>(queryKey, (oldData) =>
                    updater(oldData, variables),
                );
            }

            // Retorne o contexto com previousData
            return { previousData };
        },
        onError: (err, variables, context) => {
            if (context?.previousData !== undefined) {
                queryClient.setQueryData<T>(queryKey, context.previousData);
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey });
        },
    });
};

export const usePost = <T, S>(
    url: string,
    params?: AxiosRequestConfig<any>,
    updater?: (oldData: T | undefined, newData: S) => T,
): UseMutationResult<
    S,
    AxiosError<unknown, any>,
    S,
    { previousData: T | undefined }
> => {
    const mutationFunction: MutationFunction<S, S> = (data: S) => {
        return axiosAuthorized.post<S>(url, data);
    };

    return useGenericMutation<T, S>(mutationFunction, url, params, updater);
};

export const useUpdate = <T, S>(
    url: string,
    params?: AxiosRequestConfig<any>,
    updater?: (oldData: T | undefined, newData: S) => T,
): UseMutationResult<
    S,
    AxiosError<unknown, any>,
    S,
    { previousData: T | undefined }
> => {
    const mutationFunction: MutationFunction<S, S> = (data: S) => {
        return axiosAuthorized.patch<S>(url, data);
    };

    return useGenericMutation<T, S>(mutationFunction, url, params, updater);
};

export function generateQueryKey(
    url: string,
    params?: { params?: Record<string, unknown> },
): [string, Record<string, unknown>?] {
    if (params) return [url, sortKeysFor(params)];
    return [url];
}

const sortKeysFor = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.keys(obj)
        .sort()
        .reduce(
            (o, key) => {
                o[key] = obj[key];
                return o;
            },
            {} as Record<string, unknown>,
        );
