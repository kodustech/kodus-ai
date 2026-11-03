import { createLogger } from '@libs/core/log/logger';

/** Dev/self-hosted default: the ECS stop grace of 30s minus 5s of headroom. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

/**
 * The drain budget also sizes the worker's force-exit timer. Node clamps a
 * timer above 2^31-1 ms to ~1 ms, so an extra zero would force-exit at once,
 * mid-drain; ten minutes is far above prod's 240s.
 */
export const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Bound on releasing this host's inbox locks after the drain. The worker's
 * force-exit timer leaves this much room for it.
 */
export const INBOX_RELEASE_TIMEOUT_MS = 10_000;

/**
 * How long a shutting-down worker waits for its running jobs
 * (API_WORKER_DRAIN_TIMEOUT_MS). The single reader of that variable: the
 * job consumer's drain and the worker's force-exit timer must agree on it,
 * or the force-exit fires before the drain it is meant to cover ends.
 * Malformed or out-of-range values fall back to the default with a warn.
 */
export function parseDrainTimeoutMs(): number {
    const raw = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
    if (!raw) return DEFAULT_DRAIN_TIMEOUT_MS;

    // The whole value must be a number of milliseconds: parseInt would read
    // "30s" or "2.4e5" as 30 or 2, a drain of almost nothing.
    const trimmed = raw.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (
        !Number.isFinite(parsed) ||
        parsed <= 0 ||
        parsed > MAX_DRAIN_TIMEOUT_MS
    ) {
        createLogger('DrainTimeout').warn({
            message:
                'API_WORKER_DRAIN_TIMEOUT_MS is not a whole number of milliseconds in range; using the default',
            context: 'DrainTimeout',
            metadata: {
                configured: raw,
                max: MAX_DRAIN_TIMEOUT_MS,
                default: DEFAULT_DRAIN_TIMEOUT_MS,
            },
        });
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }
    return parsed;
}
