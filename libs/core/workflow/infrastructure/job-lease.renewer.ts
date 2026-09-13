import type { SimpleLogger } from '@libs/core/log/logger';

// Job-ownership lease (issue #1830). A worker processing a workflow job renews
// a lease (`leaseExpiresAt`) on a fixed cadence while the job runs; the
// stale-job reaper reclaims PROCESSING jobs by an EXPIRED lease, which detects
// a dead worker (kill -9, OOM, ECS eviction) in ~90s instead of waiting out the
// 180-min in-process timeout that dies with the process. Constants are kept
// deliberate (no env-tuning), matching the existing `staleJobTimeoutMinutes`
// policy.
export const JOB_LEASE_TTL_MS = 90_000;
export const JOB_LEASE_RENEW_INTERVAL_MS = 30_000;
/**
 * Consecutive renewal failures tolerated before the lease is treated as lost.
 * A single blip is forgiven (the next tick re-renews well within the 90s TTL);
 * a DB outage that spans more than one renewal interval is not, because by then
 * the reaper may reclaim a job whose worker is still alive — a double
 * execution. Two failures is one full interval of confirmed un-renewability.
 */
export const JOB_LEASE_MAX_CONSECUTIVE_FAILURES = 2;

export interface JobLeaseRenewalOptions {
    /** Abort signal that stops the renewal (parent worker cancellation). */
    signal: AbortSignal;
    /** Writes `leaseExpiresAt = now + TTL` for the owned job. */
    renew: () => Promise<void> | void;
    /** Renewal cadence (defaults to `JOB_LEASE_RENEW_INTERVAL_MS`). */
    intervalMs?: number;
    /**
     * Logger for renewal failures. A renewal failure must never be silent:
     * without a log line, a worker that quietly stops owning its job looks
     * identical to a healthy one from the outside. Optional for callers/tests
     * that do not wire a logger.
     */
    logger?: SimpleLogger;
    /** Job id, surfaced in the failure log metadata when available. */
    jobId?: string;
    /** Organization id, surfaced in the failure log metadata when available. */
    organizationId?: string;
    /** Surface a renewal write failure (e.g. transient DB error). */
    onRenewError?: (error: unknown) => void;
    /**
     * Consecutive failures tolerated before the lease is considered lost
     * (defaults to `JOB_LEASE_MAX_CONSECUTIVE_FAILURES`).
     */
    maxConsecutiveFailures?: number;
    /**
     * Invoked ONCE, when `maxConsecutiveFailures` consecutive renewals have
     * failed. At that point the worker can no longer guarantee it owns the job
     * — the reaper is free to reclaim it — so the caller must stop running
     * (abort the use-case) to avoid a double execution.
     */
    onLeaseLost?: (error: unknown) => void;
}

export interface JobLeaseRenewal {
    /** Stop renewing once the work completes. */
    stop: () => void;
}

/**
 * Runs `renew` on a fixed cadence until the caller calls `stop()` or the parent
 * signal aborts.
 *
 * Failures are never silent: each one is logged (when a `logger` is supplied)
 * and surfaced via `onRenewError`. A single transient failure does not crash the
 * running job — the lease merely expires and the reaper reclaims it if the
 * worker truly died. But `maxConsecutiveFailures` failures in a row mean the
 * worker can no longer renew its lease while it is (apparently) alive, which is
 * exactly the window where the reaper would reclaim a live job: at that point
 * renewal stops and `onLeaseLost` fires so the caller can abort the run instead
 * of racing the reaper toward a double execution (#1830 review).
 */
export function startJobLeaseRenewal(
    options: JobLeaseRenewalOptions,
): JobLeaseRenewal {
    const intervalMs = options.intervalMs ?? JOB_LEASE_RENEW_INTERVAL_MS;
    const maxConsecutiveFailures =
        options.maxConsecutiveFailures ?? JOB_LEASE_MAX_CONSECUTIVE_FAILURES;

    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let leaseLost = false;
    let consecutiveFailures = 0;

    const stop = (): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        if (timer) {
            clearInterval(timer);
        }
    };

    const handleFailure = (error: unknown): void => {
        consecutiveFailures += 1;

        const errorObject =
            error instanceof Error ? error : new Error(String(error));
        const metadata: Record<string, unknown> = {
            intervalMs,
            consecutiveFailures,
            maxConsecutiveFailures,
        };
        if (options.jobId) {
            metadata.jobId = options.jobId;
        }
        if (options.organizationId) {
            metadata.organizationId = options.organizationId;
        }

        options.logger?.error({
            message: 'Failed to renew workflow job lease',
            context: 'startJobLeaseRenewal',
            error: errorObject,
            metadata,
        });

        options.onRenewError?.(error);

        if (!leaseLost && consecutiveFailures >= maxConsecutiveFailures) {
            leaseLost = true;
            // Stop renewing: there is no point hammering a lease we no longer
            // own, and stopping makes the loss terminal for the caller.
            stop();
            options.onLeaseLost?.(error);
        }
    };

    timer = setInterval(() => {
        try {
            void Promise.resolve(options.renew()).then(
                () => {
                    // A successful tick proves the worker still owns the job.
                    consecutiveFailures = 0;
                },
                (error) => handleFailure(error),
            );
        } catch (error) {
            handleFailure(error);
        }
    }, intervalMs);
    // Do not keep the event loop (and thus the worker) alive solely for the
    // renewal cadence.
    timer.unref?.();

    options.signal.addEventListener('abort', stop, { once: true });
    return { stop };
}
