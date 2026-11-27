import {
    createMemoryWindow,
    gcRecordsOf,
    startMemorySampler,
} from './memory-sampler';

const MB = 1024 * 1024;

const usage = {
    rss: 3000 * MB,
    heapUsed: 2000 * MB,
    heapTotal: 2500 * MB,
    external: 100 * MB,
    arrayBuffers: 40 * MB,
} as NodeJS.MemoryUsage;

const sources = {
    memoryUsage: () => usage,
    heapLimit: () => 8192 * MB,
};

describe('memory window', () => {
    it('reports the heap each full collection left, not the heap in between', () => {
        const w = createMemoryWindow(sources);

        const out = w.take([
            // a scavenge does not say what is live
            { major: false, costMs: 2, heapAfterBytes: 1500 * MB },
            { major: true, costMs: 40, heapAfterBytes: 900 * MB },
            { major: true, costMs: 60, heapAfterBytes: 700 * MB },
        ]);

        expect(out).toEqual({
            rssMb: 3000,
            heapUsedMb: 2000,
            heapTotalMb: 2500,
            heapLimitMb: 8192,
            externalMb: 100,
            arrayBuffersMb: 40,
            heapAfterMajorGcMb: 700,
            heapAfterMajorGcMinMb: 700,
            majorGcs: 2,
            gcPauseMs: 102,
            gcMaxPauseMs: 60,
        });
    });

    it('starts each window fresh but keeps the last post-GC reading', () => {
        const w = createMemoryWindow(sources);
        w.take([{ major: true, costMs: 10, heapAfterBytes: 500 * MB }]);

        expect(w.take([])).toEqual({
            rssMb: 3000,
            heapUsedMb: 2000,
            heapTotalMb: 2500,
            heapLimitMb: 8192,
            externalMb: 100,
            arrayBuffersMb: 40,
            heapAfterMajorGcMb: 500,
            heapAfterMajorGcMinMb: null,
            majorGcs: 0,
            gcPauseMs: 0,
            gcMaxPauseMs: 0,
        });
    });

    it('says when no full collection has run yet', () => {
        const w = createMemoryWindow(sources);
        expect(w.take([]).heapAfterMajorGcMb).toBeNull();
    });
});

describe('gcRecordsOf', () => {
    it('reads the type, the cost in microseconds and the heap after each collection', () => {
        expect(
            gcRecordsOf({
                statistics: [
                    {
                        gcType: 'Scavenge',
                        cost: 1500,
                        afterGC: { heapStatistics: { usedHeapSize: 10 } },
                    },
                    {
                        gcType: 'MarkSweepCompact',
                        cost: 42000,
                        afterGC: { heapStatistics: { usedHeapSize: 7 } },
                    },
                ],
            }),
        ).toEqual([
            { major: false, costMs: 1.5, heapAfterBytes: 10 },
            { major: true, costMs: 42, heapAfterBytes: 7 },
        ]);
    });

    it('reads an empty profile as no collections', () => {
        expect(gcRecordsOf({})).toEqual([]);
    });
});

describe('startMemorySampler', () => {
    it('reads the collections V8 records in a real process', async () => {
        const sampler = startMemorySampler();
        sampler.take(); // start a clean window
        // Churn short-lived arrays: young-generation collections are certain.
        for (let r = 0; r < 30; r++) {
            const garbage: number[][] = [];
            for (let i = 0; i < 20; i++) garbage.push(new Array(2e5).fill(r));
            await new Promise((resolve) => setImmediate(resolve));
        }
        const w = sampler.take();
        sampler.stop();

        expect(w.gcPauseMs + w.gcMaxPauseMs).toBeGreaterThan(0);
        expect(w.rssMb).toBeGreaterThan(w.heapUsedMb);
    });
});
