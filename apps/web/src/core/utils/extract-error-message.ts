import { isAxiosError } from "axios";

const extractErrorMessage = (error: unknown): string | undefined => {
    if (!isAxiosError(error)) return;

    const data = error.response?.data as
        { message?: string | string[] } | undefined;

    if (Array.isArray(data?.message)) {
        return data.message.join(", ");
    }

    return data?.message;
};

// The API's own text for a request it rejected — it names the fix. A 500
// or a request that never got an answer has nothing the user can act on.
// 503 is included: the scan start names a down worker as something to retry.
export const extractRejectionMessage = (error: unknown): string | undefined => {
    if (!isAxiosError(error)) return;
    const status = error.response?.status;
    if (!status || (status >= 500 && status !== 503)) return;
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
