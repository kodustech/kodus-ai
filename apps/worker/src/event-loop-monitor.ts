import { monitorEventLoopDelay, PerformanceObserver } from 'perf_hooks';
import { createLogger } from '@libs/core/log/logger';

import { getLastHealthProbe } from './health-probe';
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
const BYTES_PER_MB = 1024 * 1024;

/**
 * Where the process's memory is, once per window. Workers grow ~100 MB/h
 * until the 8 GB heap limit (Nov 2026) and the container metric cannot say
 * whether that is the JS heap (objects kept alive) or memory outside it
 * (WASM such as tiktoken, Buffers, native addons): `heapUsedMb` growing
 * points at the heap, `externalMb`/`arrayBuffersMb` or `rssMb` growing
 * alone at the rest.
 */
function memorySnapshot(): Record<string, number> {
    const m = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
    return {
        rssMb: mb(m.rss),
        heapUsedMb: mb(m.heapUsed),
        heapTotalMb: mb(m.heapTotal),
        externalMb: mb(m.external),
        arrayBuffersMb: mb(m.arrayBuffers),
    };
}

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

    // Time spent in garbage collection per window: a heap near its limit
    // shows up here before it shows up as an out-of-memory kill.
    const gc = { ms: 0, count: 0 };
    let gcObserver: PerformanceObserver | null = null;
    try {
        gcObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                gc.ms += entry.duration;
                gc.count++;
            }
        });
        gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
        gcObserver = null;
    }

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
                    ...memorySnapshot(),
                    gcMs: Math.round(gc.ms),
                    gcCount: gc.count,
                },
            };
            histogram.reset();
            gc.ms = 0;
            gc.count = 0;

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
        gcObserver?.disconnect();
        stopWatchdog();
    };
}
