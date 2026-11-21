"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { typedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

// The Runtime secrets of the organization (GET/POST/PATCH/DELETE
// /runtime/secrets, org owner only). A value is sent, never received: no
// response, cache entry or log of the screen holds it.

export type RuntimeSecretActor = { userId: string; email?: string };

export type RuntimeSecret = {
    secretId: string;
    name: string;
    hosts: string[];
    createdBy: RuntimeSecretActor;
    createdAt: string;
    updatedBy: RuntimeSecretActor;
    updatedAt: string;
    valueSetAt: string;
};

export type RuntimeSecretsList = {
    /** false: this Kodus has no secret store; the screen says so and offers nothing. */
    configured: boolean;
    secrets: RuntimeSecret[];
};

const enc = encodeURIComponent;
const PATHS = {
    SECRETS: () => pathToApiUrl("/runtime/secrets"),
    SECRET: (secretId: string) =>
        pathToApiUrl(`/runtime/secrets/${enc(secretId)}`),
} as const;

const unwrap = <T>(payload: unknown): T =>
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
        ? ((payload as { data: T }).data as T)
        : (payload as T);

const call = async <T>(
    url: string,
    init?: Parameters<typeof typedFetch>[1],
): Promise<T> => unwrap<T>(await typedFetch<unknown>(url, init));

export const listRuntimeSecrets = () => call<RuntimeSecretsList>(PATHS.SECRETS());

export const createRuntimeSecret = (body: {
    name: string;
    hosts: string[];
    value: string;
}) =>
    call<RuntimeSecret>(PATHS.SECRETS(), {
        method: "POST",
        body: JSON.stringify(body),
    });

/** Only the fields sent change. */
export const updateRuntimeSecret = ({
    secretId,
    ...body
}: {
    secretId: string;
    hosts?: string[];
    value?: string;
}) =>
    call<RuntimeSecret>(PATHS.SECRET(secretId), {
        method: "PATCH",
        body: JSON.stringify(body),
    });

export const deleteRuntimeSecret = (secretId: string) =>
    call<unknown>(PATHS.SECRET(secretId), { method: "DELETE" });

export const runtimeSecretKeys = {
    list: () => ["runtime", "secrets"] as const,
};

export const useRuntimeSecrets = (enabled = true) =>
    useQuery({
        queryKey: runtimeSecretKeys.list(),
        queryFn: listRuntimeSecrets,
        enabled,
    });

const useSecretMutation = <TInput,>(fn: (input: TInput) => Promise<unknown>) => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: fn,
        // The variables hold the value: dropped as soon as the form is gone,
        // not after the cache's default five minutes.
        gcTime: 0,
        // The answer is metadata only; the list is read again rather than patched.
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeSecretKeys.list(),
            }),
    });
};

export const useCreateRuntimeSecret = () =>
    useSecretMutation(createRuntimeSecret);
export const useUpdateRuntimeSecret = () =>
    useSecretMutation(updateRuntimeSecret);
export const useDeleteRuntimeSecret = () =>
    useSecretMutation(deleteRuntimeSecret);
