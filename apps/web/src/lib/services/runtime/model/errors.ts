// What a failed Runtime call tells the person. The API answers Nest errors
// (`{ statusCode, message }`, maybe in a `{ data }` envelope); the toast
// shows the API's own sentence when it has one, else a line per status.

type ErrorLike = { statusCode?: unknown; body?: unknown; message?: unknown };

const apiMessage = (body: unknown): string | undefined => {
    if (!body || typeof body !== "object") return undefined;
    const b = body as { message?: unknown; error?: unknown; data?: unknown };
    if (typeof b.message === "string" && b.message.trim()) return b.message;
    if (Array.isArray(b.message) && typeof b.message[0] === "string")
        return b.message.join(" ");
    return apiMessage(b.data);
};

export const errorStatus = (error: unknown): number | undefined => {
    const status = (error as ErrorLike | null)?.statusCode;
    return typeof status === "number" ? status : undefined;
};

export const isNotFoundError = (error: unknown) => errorStatus(error) === 404;

export const runtimeErrorMessage = (
    error: unknown,
    byStatus: Partial<Record<number, string>> & { fallback: string },
): string => {
    const status = errorStatus(error);
    if (status !== undefined && byStatus[status]) return byStatus[status]!;
    const fromApi = apiMessage((error as ErrorLike | null)?.body);
    if (fromApi && status !== undefined && status < 500) return fromApi;
    if (status === 403) return "You do not have permission to do this here.";
    return byStatus.fallback;
};
