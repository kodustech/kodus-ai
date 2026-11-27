import { constants, PerformanceObserver } from 'perf_hooks';
import { getHeapStatistics } from 'v8';

/**
 * What the worker holds in memory over one window, to size how many reviews
 * fit in a process. RSS and heapUsed alone overstate the live set: V8 lets
 * the heap grow up to --max-old-space-size before collecting. The heap
 * right after a major (mark-sweep-compact) collection is the closest view of
 * what is actually reachable, and it needs no --expose-gc: the GC
 * observer's callback runs just after the collection ends.
 */
export interface MemoryWindow {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    heapLimitMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    /** Heap after the last major GC in the window; null when none ran. */
    heapAfterMajorGcMb: number | null;
    /** Smallest heap after a major GC in the window. */
    heapAfterMajorGcMinMb: number | null;
    majorGcs: number;
    gcPauseMs: number;
    gcMaxPauseMs: number;
}

export interface MemoryWindowSources {
    memoryUsage: () => NodeJS.MemoryUsage;
    heapUsed: () => number;
    heapLimit: () => number;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / MB);

/** The window's arithmetic, apart from the GC observer so it can be tested. */
export function createMemoryWindow(sources: MemoryWindowSources) {
    let lastAfterMajor: number | null = null;
    let minAfterMajor: number | null = null;
    let majorGcs = 0;
    let pauseMs = 0;
    let maxPauseMs = 0;

    return {
        onGc(major: boolean, durationMs: number): void {
            pauseMs += durationMs;
            maxPauseMs = Math.max(maxPauseMs, durationMs);
            if (!major) return;
            majorGcs++;
            const used = sources.heapUsed();
            lastAfterMajor = used;
            minAfterMajor =
                minAfterMajor === null ? used : Math.min(minAfterMajor, used);
        },
        take(): MemoryWindow {
            const m = sources.memoryUsage();
            const out: MemoryWindow = {
                rssMb: mb(m.rss),
                heapUsedMb: mb(m.heapUsed),
                heapTotalMb: mb(m.heapTotal),
                heapLimitMb: mb(sources.heapLimit()),
                externalMb: mb(m.external),
                arrayBuffersMb: mb(m.arrayBuffers),
                heapAfterMajorGcMb:
                    lastAfterMajor === null ? null : mb(lastAfterMajor),
                heapAfterMajorGcMinMb:
                    minAfterMajor === null ? null : mb(minAfterMajor),
                majorGcs,
                gcPauseMs: Math.round(pauseMs),
                gcMaxPauseMs: Math.round(maxPauseMs),
            };
            // The last reading carries over: a quiet window with no major GC
            // still says what the last one left.
            minAfterMajor = null;
            majorGcs = 0;
            pauseMs = 0;
            maxPauseMs = 0;
            return out;
        },
    };
}

/** Starts observing GC; `take()` returns and resets the current window. */
export function startMemorySampler(): {
    take: () => MemoryWindow;
    stop: () => void;
} {
    const window = createMemoryWindow({
        memoryUsage: () => process.memoryUsage(),
        heapUsed: () => getHeapStatistics().used_heap_size,
        heapLimit: () => getHeapStatistics().heap_size_limit,
    });
    const observer = new PerformanceObserver((list) => {
        try {
            for (const entry of list.getEntries()) {
                const kind = (entry as any).detail?.kind;
                window.onGc(
                    kind === constants.NODE_PERFORMANCE_GC_MAJOR,
                    entry.duration,
                );
            }
        } catch {
            // diagnostics must never take the worker down
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    return { take: () => window.take(), stop: () => observer.disconnect() };
}
