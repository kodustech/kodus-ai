import { monitorEventLoopDelay, PerformanceObserver } from 'perf_hooks';

import { startEventLoopMonitor } from './event-loop-monitor';

jest.mock('perf_hooks', () => ({
    ...jest.requireActual('perf_hooks'),
    monitorEventLoopDelay: jest.fn(),
    PerformanceObserver: jest.fn(),
}));

/**
 * GC time per window: a heap near its limit shows here first (a worker spent
 * ~1.4 s per minute in GC before it was replaced, Nov 2026). The observer is
 * fed by hand, so the sums are exact.
 */
describe('startEventLoopMonitor — garbage collection per window', () => {
    let feed: (durations: number[]) => void;
    const observe = jest.fn();
    const disconnect = jest.fn();

    beforeEach(() => {
        jest.useFakeTimers();
        jest.mocked(monitorEventLoopDelay).mockReturnValue({
            max: 1e6,
            mean: 1e6,
            percentile: () => 1e6,
            enable: jest.fn(),
            disable: jest.fn(),
            reset: jest.fn(),
        } as any);
        jest.mocked(PerformanceObserver).mockImplementation(((cb: any) => {
            feed = (durations) =>
                cb({ getEntries: () => durations.map((duration) => ({ duration })) });
            return { observe, disconnect };
        }) as any);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('sums GC time and count per window and starts each window at zero', () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        const stop = startEventLoopMonitor({ intervalMs: 100, warnMs: 1_000, logger });

        expect(observe).toHaveBeenCalledWith({ entryTypes: ['gc'] });
        feed([12.4, 30.2]);
        feed([7.5]);
        jest.advanceTimersByTime(100);
        jest.advanceTimersByTime(100);
        stop();

        const windows = logger.log.mock.calls.map(([p]) => p.metadata);
        expect(windows.map((m) => [m.gcMs, m.gcCount])).toEqual([
            [50, 3],
            [0, 0],
        ]);
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('keeps running when the GC observer is not available', () => {
        jest.mocked(PerformanceObserver).mockImplementation((() => {
            throw new Error('unsupported');
        }) as any);
        const logger = { log: jest.fn(), warn: jest.fn() };
        const stop = startEventLoopMonitor({ intervalMs: 100, warnMs: 1_000, logger });

        jest.advanceTimersByTime(100);
        stop();

        expect(logger.log.mock.calls[0][0].metadata).toEqual(
            expect.objectContaining({ gcMs: 0, gcCount: 0 }),
        );
    });
});
