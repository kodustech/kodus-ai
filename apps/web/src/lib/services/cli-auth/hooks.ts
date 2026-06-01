import { useMutation, useQuery } from "@tanstack/react-query";

import { axiosAuthorized } from "src/core/utils/axios";

import {
    CLI_AUTH_API,
    type CliLoginInfo,
    type CompleteCliLoginResult,
} from "./fetch";

/**
 * The API wraps every response in `{ data, statusCode, type }`. Most callers
 * in the codebase rely on the wrapper bleeding through; we keep that intact
 * and just unwrap here so the hook surfaces the typed payload directly.
 */
function unwrap<T>(payload: unknown): T {
    if (payload && typeof payload === "object" && "data" in payload) {
        return (payload as { data: T }).data;
    }
    return payload as T;
}

export const useCliLoginInfo = (params: {
    state?: string;
    userCode?: string;
}) =>
    useQuery<CliLoginInfo, Error>({
        queryKey: ["cli-login-info", params.state, params.userCode],
        enabled: Boolean(params.state || params.userCode),
        queryFn: async () => {
            const url = CLI_AUTH_API.LOGIN_INFO(params);
            const raw = await axiosAuthorized.fetcher<unknown>(url);
            return unwrap<CliLoginInfo>(raw);
        },
        retry: false,
        staleTime: 0,
    });

export const useCompleteCliLogin = () =>
    useMutation<
        CompleteCliLoginResult,
        Error,
        { state?: string; userCode?: string }
    >({
        mutationFn: async (body) => {
            const url = CLI_AUTH_API.LOGIN_COMPLETE();
            const raw = await axiosAuthorized.post<unknown>(url, body);
            return unwrap<CompleteCliLoginResult>(raw);
        },
    });
