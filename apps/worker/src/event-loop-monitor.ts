import { monitorEventLoopDelay } from 'perf_hooks';
import { createLogger } from '@libs/core/log/logger';

import { getLastHealthProbe } from './health-probe';

type MonitorLogger = Pick<ReturnType<typeof createLogger>, 'log' | 'warn'>;

export interface EventLoopMonitorOptions {
    /** How often to report and reset the histogram. */
    intervalMs?: number;
    /** A window whose max delay exceeds this is logged as a warning. */
    warnMs?: number;
    /** Injected in tests; defaults to the worker logger. */
    logger?: MonitorLogger;
}

const NS_PER_MS = 1e6;

/**
 * Reports how long the main thread was unable to run callbacks. The ECS
 * health check is served on this same thread with a 4s budget, so a task
 * recycled as "unhealthy" either shows a delay spike here (the worker was
 * blocked) or does not — and then `msSinceLastProbe` tells whether probes
 * were even arriving (a failing health-check command vs. a failing probe).
 *
 * Returns a stop function.
 */
export function startEventLoopMonitor(
    opts: EventLoopMonitorOptions = {},
): () => void {
    const {
        intervalMs = 60_000,
        warnMs = 1_000,
        logger = createLogger('EventLoopMonitor'),
    } = opts;

    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const timer = setInterval(() => {
        // A throw inside a timer callback would crash the process — this is
        // diagnostics, it must never take the worker down.
        try {
            const maxMs = histogram.max / NS_PER_MS;
            const probe = getLastHealthProbe();
            const payload = {
                message: `Event loop delay max=${Math.round(maxMs)}ms`,
                context: 'EventLoopMonitor',
                metadata: {
                    p50Ms: Math.round(histogram.percentile(50) / NS_PER_MS),
                    p99Ms: Math.round(histogram.percentile(99) / NS_PER_MS),
                    maxMs: Math.round(maxMs),
                    meanMs: Math.round(histogram.mean / NS_PER_MS),
                    windowMs: intervalMs,
                    msSinceLastProbe: probe ? Date.now() - probe.at : null,
                    lastProbeStatus: probe?.status ?? null,
                },
            };
            histogram.reset();

            if (maxMs > warnMs) logger.warn(payload);
            else logger.log(payload);
        } catch {
            histogram.reset();
        }
    }, intervalMs);
    timer.unref();

    return () => {
        clearInterval(timer);
        histogram.disable();
    };
}
