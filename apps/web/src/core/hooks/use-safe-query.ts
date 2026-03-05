import type { UseQueryOptions } from "@tanstack/react-query";
import type { AxiosRequestConfig } from "axios";
import { useFetch } from "src/core/utils/reactQuery";

interface UseSafeQueryOptions<T> extends Omit<
    UseQueryOptions<T, Error>,
    "queryKey" | "queryFn"
> {
    fallbackData?: T;
}

export function useSafeQuery<T>(
    url: string | null,
    params?: AxiosRequestConfig<any>,
    options?: UseSafeQueryOptions<T>,
) {
    const { fallbackData, ...queryOptions } = options ?? {};

    const query = useFetch<T>(url, params, true, queryOptions);

    const data = query.data ?? fallbackData;
    const isEmpty =
        !query.isLoading &&
        !query.isError &&
        (data === undefined ||
            data === null ||
            (Array.isArray(data) && data.length === 0));

    return {
        ...query,
        data,
        isEmpty,
        hasError: query.isError,
    };
}
