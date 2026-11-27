import { createMemoryWindow, startMemorySampler } from './memory-sampler';

const MB = 1024 * 1024;

describe('memory window', () => {
    const usage = {
        rss: 3000 * MB,
        heapUsed: 2000 * MB,
        heapTotal: 2500 * MB,
        external: 100 * MB,
        arrayBuffers: 40 * MB,
    } as NodeJS.MemoryUsage;

    it('reports the heap left by major collections, not the heap in between', () => {
        let heap = 900 * MB;
        const w = createMemoryWindow({
            memoryUsage: () => usage,
            heapUsed: () => heap,
            heapLimit: () => 8192 * MB,
        });

        w.onGc(false, 2); // a scavenge does not say what is live
        w.onGc(true, 40);
        heap = 700 * MB;
        w.onGc(true, 60);

        expect(w.take()).toEqual({
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
        const w = createMemoryWindow({
            memoryUsage: () => usage,
            heapUsed: () => 500 * MB,
            heapLimit: () => 8192 * MB,
        });
        w.onGc(true, 10);
        w.take();

        expect(w.take()).toMatchObject({
            heapAfterMajorGcMb: 500,
            heapAfterMajorGcMinMb: null,
            majorGcs: 0,
            gcPauseMs: 0,
        });
    });

    it('says when no major collection has run yet', () => {
        const w = createMemoryWindow({
            memoryUsage: () => usage,
            heapUsed: () => 0,
            heapLimit: () => 0,
        });
        expect(w.take().heapAfterMajorGcMb).toBeNull();
    });
});

describe('startMemorySampler', () => {
    it('reads the live process without throwing and can be stopped', () => {
        const sampler = startMemorySampler();
        const w = sampler.take();
        sampler.stop();
        expect(w.rssMb).toBeGreaterThan(0);
        expect(w.heapLimitMb).toBeGreaterThan(0);
    });
});
