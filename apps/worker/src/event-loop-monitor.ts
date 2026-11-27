import { monitorEventLoopDelay } from 'perf_hooks';
import { activityCounts } from '@libs/core/infrastructure/activity/activity-registry';
import { readMemoryGauges } from '@libs/core/infrastructure/memory/memory-gauges';
import { createLogger } from '@libs/core/log/logger';

import { getLastHealthProbe } from './health-probe';
import { startMemorySampler } from './memory-sampler';
import { StallWatchdogOptions, startStallWatchdog } from './stall-watchdog';

type MonitorLogger = Pick<ReturnType<typeof createLogger>, 'log' | 'warn'>;

export interface EventLoopMonitorOptions {
    /** How often to report and reset the histogram. */
    intervalMs?: number;
    /** A window whose max delay exceeds this is logged as a warning. */
    warnMs?: number;
    /** Injected in tests; defaults to the worker logger. */
    logger?: MonitorLogger;
    /**
     * Also watch the thread from outside it: a separate thread that captures
     * the stack of a stall while it happens (see stall-watchdog.ts). Off when
     * omitted.
     */
    stallWatchdog?: StallWatchdogOptions;
}

const NS_PER_MS = 1e6;

/**
 * Reports how long the main thread was unable to run callbacks. The ECS
 * health check is served on this same thread with a 4s budget, so a task
 * recycled as "unhealthy" either shows a delay spike here (the worker was
 * blocked) or does not — and then `msSinceLastProbe` tells whether probes
 * were even arriving (a failing health-check command vs. a failing probe).
 *
 * The report runs on the thread it measures. A block that lasts until ECS
 * kills the task never produces the spike line; the evidence is the
 * once-per-window line going missing before the recycle. The optional stall
 * watchdog closes that gap: it runs on another thread and names the code the
 * main thread is stuck in while the stall is still happening.
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
    // Memory and jobs ride on the same line, so one line per window says
    // how much the process held, how many jobs of what size held it, and
    // whether the thread was blocked.
    const memory = startMemorySampler();

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
                    memory: memory.take(),
                    jobs: activityCounts(),
                    gauges: readMemoryGauges(),
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

    const stopWatchdog = opts.stallWatchdog
        ? startStallWatchdog(opts.stallWatchdog)
        : () => undefined;

    return () => {
        clearInterval(timer);
        histogram.disable();
        memory.stop();
        stopWatchdog();
    };
}
