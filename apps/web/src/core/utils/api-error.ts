/** The API's reason for a refused request (`{ message }` in the body), when it gave one. */
export function apiErrorMessage(err: unknown): string | undefined {
    const message = (
        err as { response?: { data?: { message?: unknown } } } | undefined
    )?.response?.data?.message;
    return typeof message === "string" && message ? message : undefined;
}
