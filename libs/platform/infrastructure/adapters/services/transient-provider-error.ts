const NETWORK_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ENETUNREACH',
    'EHOSTUNREACH',
]);

type ErrorLike = {
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
    message?: string;
    isAxiosError?: boolean;
    response?: { status?: number; headers?: unknown };
    cause?: ErrorLike;
};

const statusOf = (error: ErrorLike | undefined): number | undefined =>
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.cause?.response?.status;

const header = (headers: unknown, name: string): string | undefined => {
    if (!headers) return undefined;
    if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name) ?? undefined;
    }
    const value = (headers as Record<string, unknown>)[name];
    return value === undefined ? undefined : String(value);
};

const isNetworkFailure = (error: ErrorLike | undefined): boolean =>
    !!error &&
    (NETWORK_CODES.has(error.code ?? '') ||
        (error.code ?? '').startsWith('UND_ERR_') ||
        error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        (error.isAxiosError === true && !error.response) ||
        isNetworkFailure(error.cause));

/**
 * A failure the next attempt may not repeat: a 5xx, a rate limit (429, or a
 * 403 carrying rate-limit headers) or no answer at all. A 401, a 404, a 400
 * or a programming error is not: retrying gets the same result.
 */
export function isTransientProviderError(error: unknown): boolean {
    const candidate = error as ErrorLike | undefined;
    const status = statusOf(candidate);

    if (status === undefined) return isNetworkFailure(candidate);
    if (status >= 500 || status === 429) return true;
    if (status === 403) {
        const headers =
            candidate?.response?.headers ?? candidate?.cause?.response?.headers;
        return (
            header(headers, 'x-ratelimit-remaining') === '0' ||
            header(headers, 'retry-after') !== undefined ||
            /rate limit/i.test(candidate?.message ?? '')
        );
    }
    return false;
}
