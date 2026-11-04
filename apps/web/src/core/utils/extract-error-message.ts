import { isAxiosError } from "axios";

const extractErrorMessage = (error: unknown): string | undefined => {
    if (!isAxiosError(error)) return;

    const data = error.response?.data as
        | { message?: string | string[] }
        | undefined;

    if (Array.isArray(data?.message)) {
        return data.message.join(", ");
    }

    return data?.message;
};

// The API's own text for a request it rejected (4xx) — it names the fix. A 5xx
// or a request that never got an answer has nothing the user can act on.
export const extractRejectionMessage = (error: unknown): string | undefined => {
    if (!isAxiosError(error)) return;
    const status = error.response?.status;
    if (!status || status >= 500) return;
    return extractErrorMessage(error);
};

export const setIntegrationError = (
    error: unknown,
    setError: (value: { message: string }) => void,
) => {
    setError({
        message:
            extractErrorMessage(error) ??
            "We couldn't save your integration. Check your token and permissions and try again.",
    });
};
