// Job-ownership lease (issue #1830). A worker processing a workflow job renews
// a lease (`leaseExpiresAt`) on a fixed cadence while the job runs; the
// stale-job reaper reclaims PROCESSING jobs by an EXPIRED lease, which detects
// a dead worker (kill -9, OOM, ECS eviction) in ~90s instead of waiting out the
// 180-min in-process timeout that dies with the process. Constants are kept
// deliberate (no env-tuning), matching the existing `staleJobTimeoutMinutes`
// policy.
export const JOB_LEASE_TTL_MS = 90_000;
export const JOB_LEASE_RENEW_INTERVAL_MS = 30_000;

export interface JobLeaseRenewalOptions {
    /** Abort signal that stops the renewal (parent worker cancellation). */
    signal: AbortSignal;
    /** Writes `leaseExpiresAt = now + TTL` for the owned job. */
    renew: () => Promise<void> | void;
    /** Renewal cadence (defaults to `JOB_LEASE_RENEW_INTERVAL_MS`). */
    intervalMs?: number;
    /** Surface a renewal write failure (e.g. transient DB error). */
    onRenewError?: (error: unknown) => void;
}

export interface JobLeaseRenewal {
    /** Stop renewing once the work completes. */
    stop: () => void;
}

/**
 * Runs `renew` on a fixed cadence until the caller calls `stop()` or the parent
 * signal aborts. A renewal failure is surfaced via `onRenewError` and does not
 * crash the running job — the lease merely expires and the reaper reclaims it
 * if the worker truly died.
 */
export function startJobLeaseRenewal(
    options: JobLeaseRenewalOptions,
): JobLeaseRenewal {
    const intervalMs = options.intervalMs ?? JOB_LEASE_RENEW_INTERVAL_MS;
    const timer = setInterval(() => {
        try {
            void Promise.resolve(options.renew()).catch((error) => {
                options.onRenewError?.(error);
            });
        } catch (error) {
            options.onRenewError?.(error);
        }
    }, intervalMs);
    // Do not keep the event loop (and thus the worker) alive solely for the
    // renewal cadence.
    timer.unref?.();

    const stop = (): void => clearInterval(timer);
    options.signal.addEventListener('abort', stop, { once: true });
    return { stop };
}