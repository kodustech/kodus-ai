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
