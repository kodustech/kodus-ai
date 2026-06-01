/**
 * Retry helper for provider SDK calls that surface 429 ("Too Many
 * Requests") under burst load.
 *
 * Used by GitlabService (`@gitbeaker/rest`) and BitbucketCloudService
 * (`bitbucket`) — both throw on 429 without exposing a retry-after-aware
 * built-in retry that respects the upstream `Retry-After` header.
 *
 * Strategy:
 *   1. Detect 429 by status / statusCode / message text on the thrown
 *      error (each SDK shapes it differently).
 *   2. If the error includes a `Retry-After` header (seconds or HTTP
 *      date), honour it. Otherwise back off exponentially with jitter
 *      so concurrent callers don't synchronize on a single wake-up.
 *   3. After `maxAttempts` attempts, rethrow the last error so the
 *      caller sees the real failure.
 *
 * Why this lives in core/infrastructure/http and not the providers:
 * both providers need the same logic and the rest of the platform may
 * grow more providers — keep it shared, opinionated, and provider-
 * agnostic.
 */

import { createLogger } from '@kodus/flow';

const logger = createLogger('rate-limit-retry');

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface With429RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Tag used in log lines to identify the caller. */
    label?: string;
}

export async function with429Retry<T>(
    fn: () => Promise<T>,
    options: With429RetryOptions = {},
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const label = options.label ?? 'with429Retry';

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastError = err;
            if (!is429Error(err)) {
                throw err;
            }
            if (attempt === maxAttempts - 1) {
                logger.warn({
                    message: `${label}: exhausted ${maxAttempts} attempts on 429`,
                    context: 'with429Retry',
                });
                throw err;
            }
            const delayMs = resolveDelayMs(
                err,
                attempt,
                baseDelay,
                maxDelay,
            );
            logger.warn({
                message: `${label}: 429 received, sleeping ${delayMs}ms before retry ${attempt + 2}/${maxAttempts}`,
                context: 'with429Retry',
            });
            await sleep(delayMs);
        }
    }
    // Unreachable — the loop above either returns or throws.
    throw lastError;
}

function is429Error(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as {
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown; statusCode?: unknown };
        message?: unknown;
        name?: unknown;
    };
    if (anyErr.status === 429 || anyErr.statusCode === 429) return true;
    if (
        anyErr.response &&
        (anyErr.response.status === 429 || anyErr.response.statusCode === 429)
    ) {
        return true;
    }
    const message =
        typeof anyErr.message === 'string' ? anyErr.message : '';
    const name = typeof anyErr.name === 'string' ? anyErr.name : '';
    // @gitbeaker throws `GitbeakerRetryError` with status code in the
    // message text; bitbucket SDK throws `HTTPError: Too Many Requests`.
    if (
        /\b429\b|Too Many Requests/i.test(message) ||
        name === 'GitbeakerRetryError'
    ) {
        return true;
    }
    return false;
}

function resolveDelayMs(
    err: unknown,
    attempt: number,
    baseDelay: number,
    maxDelay: number,
): number {
    const retryAfterMs = parseRetryAfter(err);
    if (retryAfterMs != null) {
        // Cap at maxDelay so we don't honour an absurd server-side hint.
        return Math.min(retryAfterMs, maxDelay);
    }
    // Exponential backoff with full jitter: 1s, 2s, 4s, 8s … capped.
    const expo = Math.min(baseDelay * 2 ** attempt, maxDelay);
    return Math.floor(Math.random() * expo);
}

function parseRetryAfter(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null;
    const headers =
        (err as { headers?: Record<string, unknown> }).headers ??
        (err as { response?: { headers?: Record<string, unknown> } }).response
            ?.headers;
    if (!headers) return null;
    const raw =
        headers['retry-after'] ?? headers['Retry-After'] ?? headers['RETRY-AFTER'];
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
        return Math.round(asNumber * 1000);
    }
    // HTTP-date form
    const asDate = Date.parse(String(raw));
    if (Number.isFinite(asDate)) {
        const deltaMs = asDate - Date.now();
        return deltaMs > 0 ? deltaMs : 0;
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
