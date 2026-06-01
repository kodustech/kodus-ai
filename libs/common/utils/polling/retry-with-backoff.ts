import {
    BackoffOptions,
    BackoffPresets,
    calculateBackoffInterval,
} from './exponential-backoff';

export interface RetryWithBackoffOptions {
    /** Total attempts, including the first. Must be >= 1. */
    maxAttempts: number;
    /** Backoff interval config. Defaults to `BackoffPresets.STANDARD`. */
    backoff?: BackoffOptions;
    /**
     * Decide whether a thrown error is worth retrying. Defaults to always
     * retrying. Return `false` to fail fast on a non-transient error.
     */
    shouldRetry?: (error: unknown) => boolean;
    /** Invoked before each backoff wait (i.e. not after the final attempt). */
    onRetry?: (details: {
        error: unknown;
        attempt: number;
        delayMs: number;
    }) => void;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying on failure with exponential backoff between attempts.
 *
 * Resolves with `fn`'s value on the first success. Rejects with the last
 * error once `maxAttempts` is exhausted, or immediately when `shouldRetry`
 * returns `false`.
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryWithBackoffOptions,
): Promise<T> {
    const {
        maxAttempts,
        backoff = BackoffPresets.STANDARD,
        shouldRetry,
        onRetry,
    } = options;

    if (maxAttempts < 1) {
        throw new Error('retryWithBackoff: maxAttempts must be >= 1');
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            const exhausted = attempt >= maxAttempts;
            if (exhausted || (shouldRetry && !shouldRetry(error))) {
                throw error;
            }

            // calculateBackoffInterval is 0-based: first retry → attempt 0.
            const delayMs = calculateBackoffInterval(attempt - 1, backoff);
            onRetry?.({ error, attempt, delayMs });
            await sleep(delayMs);
        }
    }

    // Unreachable — the loop always returns or throws — but TS needs it.
    throw lastError;
}
