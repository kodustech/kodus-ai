import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

/**
 * Octokit raises a generic Error on 403 rate-limit responses (after we
 * disabled in-octokit retries). This helper inspects the error shape
 * — status + the standard `x-ratelimit-*` response headers — and, when
 * it looks like a rate-limit failure, wraps it in `RateLimitError`
 * carrying the bucket's reset time.
 *
 * Two GitHub flavors are handled:
 *
 *   1. Primary core bucket exhausted — response includes
 *      `x-ratelimit-remaining: 0` and `x-ratelimit-reset: <unix-seconds>`.
 *      We compute `resetAt` from that header.
 *
 *   2. Secondary rate-limit (concurrent-burst throttle) — the response
 *      header is `retry-after: <seconds>` and there's no x-ratelimit-reset.
 *      We compute `resetAt = now + retryAfter`.
 *
 * If neither shape matches, the original error is returned unchanged so
 * the caller can route it through the normal RETRYABLE/PERMANENT path.
 */

export function classifyGitHubError(error: unknown): unknown {
    if (!isLikelyOctokitError(error)) return error;

    const status = getStatus(error);
    if (status !== 403 && status !== 429) return error;

    const headers = getHeaders(error);
    const remaining = pickHeader(headers, 'x-ratelimit-remaining');
    const reset = pickHeader(headers, 'x-ratelimit-reset');
    const retryAfter = pickHeader(headers, 'retry-after');

    // Primary: explicit ratelimit headers and bucket actually at zero.
    if (remaining !== undefined && Number(remaining) === 0 && reset) {
        const resetAt = new Date(Number(reset) * 1000);
        if (Number.isFinite(resetAt.getTime())) {
            return new RateLimitError({
                resetAt,
                remaining: 0,
                message: `GitHub primary rate limit: reset at ${resetAt.toISOString()}`,
            });
        }
    }

    // Secondary: retry-after header but ratelimit-remaining not zeroed
    // (rate-abuse detection rather than quota exhaustion).
    if (retryAfter !== undefined) {
        const waitSeconds = Number(retryAfter);
        if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
            const resetAt = new Date(Date.now() + waitSeconds * 1000);
            return new RateLimitError({
                resetAt,
                message: `GitHub secondary rate limit: retry-after ${waitSeconds}s`,
            });
        }
    }

    return error;
}

function isLikelyOctokitError(error: unknown): error is {
    status?: number;
    response?: { headers?: Record<string, unknown>; status?: number };
} {
    return (
        typeof error === 'object' &&
        error !== null &&
        ('status' in error || 'response' in error)
    );
}

function getStatus(error: any): number | undefined {
    return error?.status ?? error?.response?.status;
}

function getHeaders(error: any): Record<string, unknown> | undefined {
    return error?.response?.headers ?? error?.headers;
}

function pickHeader(
    headers: Record<string, unknown> | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined;
    // Octokit normalizes header names to lowercase, but be defensive.
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? String(value[0]) : String(value);
}
