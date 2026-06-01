import { Criticality } from '../domain/enums';

export interface RetryDecision {
    /** True = schedule another attempt, False = terminal failure. */
    shouldRetry: boolean;
    /** Wall-clock time of the next attempt (only meaningful when shouldRetry). */
    nextAttemptAt: Date;
    /** Total attempts allowed for this criticality, for logging. */
    maxAttempts: number;
}

/**
 * Per-criticality retry policy.
 *
 * Critical events get more attempts and a tighter initial cadence
 * because their terminal failure pages ops; informational/system events
 * back off a little slower and give up sooner.
 *
 * `attemptsSoFar` is the value AFTER the failed attempt (i.e. the
 * dispatcher just persisted `attempts = 1` for the first failure, so
 * decide(criticality, 1) is the right call).
 */
export function decideRetry(
    criticality: Criticality,
    attemptsSoFar: number,
    now: Date = new Date(),
): RetryDecision {
    const policy =
        criticality === Criticality.CRITICAL
            ? CRITICAL_POLICY
            : DEFAULT_POLICY;

    if (attemptsSoFar >= policy.maxAttempts) {
        return {
            shouldRetry: false,
            nextAttemptAt: now,
            maxAttempts: policy.maxAttempts,
        };
    }

    // Exponential: base * 2^(attempts - 1), capped.
    const exp = Math.min(
        policy.baseDelaySeconds * 2 ** (attemptsSoFar - 1),
        policy.maxDelaySeconds,
    );
    // ±15% jitter so a flaky upstream doesn't get hammered in waves.
    const jitter = exp * (0.85 + Math.random() * 0.3);
    const nextAttemptAt = new Date(now.getTime() + jitter * 1000);

    return {
        shouldRetry: true,
        nextAttemptAt,
        maxAttempts: policy.maxAttempts,
    };
}

const CRITICAL_POLICY = {
    maxAttempts: 8,
    baseDelaySeconds: 5,
    maxDelaySeconds: 5 * 60,
} as const;

const DEFAULT_POLICY = {
    maxAttempts: 5,
    baseDelaySeconds: 10,
    maxDelaySeconds: 5 * 60,
} as const;
