import {
    runActivity,
    updateActivity,
} from '@libs/core/infrastructure/activity/activity-registry';
import {
    clearMemoryGauges,
    registerMemoryGauge,
} from '@libs/core/infrastructure/memory/memory-gauges';
import { monitorEventLoopDelay } from 'perf_hooks';

import { startEventLoopMonitor } from './event-loop-monitor';
import type { MemoryWindow } from './memory-sampler';

const memoryWindow: MemoryWindow = {
    rssMb: 3000,
    heapUsedMb: 2000,
    heapTotalMb: 2500,
    heapLimitMb: 8192,
    externalMb: 100,
    arrayBuffersMb: 40,
    heapAfterMajorGcMb: 700,
    heapAfterMajorGcMinMb: 650,
    majorGcs: 2,
    gcPauseMs: 102,
    gcMaxPauseMs: 60,
};

jest.mock('./memory-sampler', () => ({
    startMemorySampler: () => ({
        take: () => memoryWindow,
        stop: () => undefined,
    }),
}));

jest.mock('perf_hooks', () => ({
    ...jest.requireActual('perf_hooks'),
    monitorEventLoopDelay: jest.fn(),
}));

describe('startEventLoopMonitor', () => {
    let stop: (() => void) | undefined;
    let histogram: {
        max: number;
        mean: number;
        percentile: jest.Mock;
        enable: jest.Mock;
        disable: jest.Mock;
        reset: jest.Mock;
    };

    beforeEach(() => {
        jest.useFakeTimers();
        histogram = {
            max: 20e6,
            mean: 10e6,
            percentile: jest.fn((percentile) =>
                percentile === 50 ? 8e6 : 18e6,
            ),
            enable: jest.fn(),
            disable: jest.fn(),
            reset: jest.fn(),
        };
        jest.mocked(monitorEventLoopDelay).mockReturnValue(
            histogram as unknown as ReturnType<typeof monitorEventLoopDelay>,
        );
    });

    afterEach(() => {
        stop?.();
        stop = undefined;
        clearMemoryGauges();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('logs a window without blocking at info level', () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        stop = startEventLoopMonitor({
            intervalMs: 100,
            warnMs: 1_000,
            logger,
        });

        jest.advanceTimersByTime(100);

        expect(logger.log).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(histogram.enable).toHaveBeenCalledTimes(1);
        expect(histogram.reset).toHaveBeenCalledTimes(1);
        expect(logger.log.mock.calls[0][0].metadata).toEqual(
            expect.objectContaining({
                p50Ms: 8,
                p99Ms: 18,
                maxMs: 20,
                meanMs: 10,
                windowMs: 100,
            }),
        );
    });

    it('reports memory, the jobs in flight and the gauges on the same line', async () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        registerMemoryGauge('cache', () => ({ entries: 7, valueMb: 3 }));
        let release!: () => void;
        const review = runActivity('job-1', {}, async () => {
            updateActivity({
                workflowType: 'CODE_REVIEW',
                changedFiles: 12,
                changedLines: 340,
            });
            await new Promise<void>((r) => (release = r));
        });
        stop = startEventLoopMonitor({ intervalMs: 100, logger });

        jest.advanceTimersByTime(100);
        release();
        await review;

        const { metadata } = logger.log.mock.calls[0][0];
        expect(metadata.memory).toEqual(memoryWindow);
        expect(metadata.jobs).toEqual({
            total: 1,
            byWorkflowType: { CODE_REVIEW: 1 },
            reviews: {
                withSize: 1,
                withLines: 1,
                changedFilesSum: 12,
                changedFilesMax: 12,
                changedLinesSum: 340,
            },
        });
        expect(metadata.gauges).toEqual({
            cache: { entries: 7, valueMb: 3 },
        });
    });

    it('warns with the measured delay when the histogram reports a blocked thread', () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        histogram.max = 400e6;
        stop = startEventLoopMonitor({ intervalMs: 100, warnMs: 200, logger });

        jest.advanceTimersByTime(100);

        expect(logger.warn).toHaveBeenCalled();
        const { metadata } = logger.warn.mock.calls[0][0];
        expect(metadata.maxMs).toBe(400);
    });

    it('survives a throwing logger and keeps reporting', () => {
        const logger = {
            log: jest.fn(() => {
                throw new Error('logger down');
            }),
            warn: jest.fn(),
        };
        stop = startEventLoopMonitor({ intervalMs: 50, logger });

        jest.advanceTimersByTime(150);

        expect(logger.log.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('stops reporting once stopped', () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        stop = startEventLoopMonitor({ intervalMs: 50, logger });
        stop();
        stop = undefined;
        logger.log.mockClear();

        jest.advanceTimersByTime(150);

        expect(logger.log).not.toHaveBeenCalled();
        expect(histogram.disable).toHaveBeenCalledTimes(1);
    });
});
