import { GCProfiler, getHeapStatistics } from 'v8';

/**
 * What the worker holds in memory over one window, to size how many reviews
 * fit in a process. RSS and heapUsed alone overstate the live set: V8 lets
 * the heap grow up to --max-old-space-size before collecting. The heap
 * right after a full (mark-sweep-compact) collection is the closest view of
 * what is actually reachable. V8's GC profiler records it inside the
 * collection itself, so allocations after the GC do not leak into the
 * reading, and it needs no --expose-gc.
 */
export interface MemoryWindow {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    heapLimitMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    /** Heap after the last full GC; carried over from an earlier window. */
    heapAfterMajorGcMb: number | null;
    /** Smallest heap after a full GC in this window; null when none ran. */
    heapAfterMajorGcMinMb: number | null;
    majorGcs: number;
    gcPauseMs: number;
    gcMaxPauseMs: number;
}

/** One collection as the window needs it. */
export interface GcRecord {
    major: boolean;
    /** Time the collection took, in ms. */
    costMs: number;
    /** Heap in use when the collection ended, in bytes; null if unreported. */
    heapAfterBytes: number | null;
}

export interface MemoryWindowSources {
    memoryUsage: () => NodeJS.MemoryUsage;
    heapLimit: () => number;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / MB);

/** The window's arithmetic, apart from the profiler so it can be tested. */
export function createMemoryWindow(sources: MemoryWindowSources) {
    let lastAfterMajor: number | null = null;

    return {
        take(gcs: GcRecord[]): MemoryWindow {
            let minAfterMajor: number | null = null;
            let majorGcs = 0;
            let pauseMs = 0;
            let maxPauseMs = 0;
            for (const gc of gcs) {
                pauseMs += gc.costMs;
                maxPauseMs = Math.max(maxPauseMs, gc.costMs);
                if (!gc.major) continue;
                majorGcs++;
                // A collection V8 did not size says nothing about the live
                // set; it must not read as an empty heap.
                if (gc.heapAfterBytes === null) continue;
                lastAfterMajor = gc.heapAfterBytes;
                minAfterMajor =
                    minAfterMajor === null
                        ? gc.heapAfterBytes
                        : Math.min(minAfterMajor, gc.heapAfterBytes);
            }
            const m = sources.memoryUsage();
            return {
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
        },
    };
}

/** V8 profiler entries to the records the window reads. */
export function gcRecordsOf(profile: {
    statistics?: Array<{
        gcType?: string;
        cost?: number;
        afterGC?: { heapStatistics?: { usedHeapSize?: number } };
    }>;
}): GcRecord[] {
    return (profile.statistics ?? []).map((s) => ({
        major: s.gcType === 'MarkSweepCompact',
        // V8 reports the cost in microseconds.
        costMs: (s.cost ?? 0) / 1000,
        heapAfterBytes: s.afterGC?.heapStatistics?.usedHeapSize ?? null,
    }));
}

/**
 * Starts profiling GC; `take()` returns the window since the last call and
 * starts the next one. The profiler keeps one record per collection until
 * `take()` drains it, so the window length bounds its memory.
 */
export function startMemorySampler(): {
    take: () => MemoryWindow;
    stop: () => void;
} {
    const window = createMemoryWindow({
        memoryUsage: () => process.memoryUsage(),
        heapLimit: () => getHeapStatistics().heap_size_limit,
    });
    let profiler = new GCProfiler();
    profiler.start();

    return {
        take: () => {
            let records: GcRecord[] = [];
            try {
                records = gcRecordsOf(profiler.stop() ?? {});
            } catch {
                // diagnostics must never take the worker down
            }
            profiler = new GCProfiler();
            profiler.start();
            return window.take(records);
        },
        stop: () => {
            try {
                profiler.stop();
            } catch {
                // already stopped
            }
        },
    };
}
