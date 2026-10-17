import { startEventLoopMonitor } from './event-loop-monitor';

const blockFor = (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // busy-wait: pins the event loop like a synchronous hot path would
    }
};

const nextTick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startEventLoopMonitor', () => {
    let stop: (() => void) | undefined;

    afterEach(() => {
        stop?.();
        stop = undefined;
    });

    it('logs a window without blocking at info level', async () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        stop = startEventLoopMonitor({ intervalMs: 100, warnMs: 1_000, logger });

        await nextTick(250);

        expect(logger.log).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.log.mock.calls[0][0].metadata).toEqual(
            expect.objectContaining({
                p50Ms: expect.any(Number),
                p99Ms: expect.any(Number),
                maxMs: expect.any(Number),
                windowMs: 100,
            }),
        );
    });

    it('warns with the measured delay when the thread is blocked', async () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        stop = startEventLoopMonitor({ intervalMs: 100, warnMs: 200, logger });

        await nextTick(30);
        blockFor(400);
        await nextTick(150);

        expect(logger.warn).toHaveBeenCalled();
        const { metadata } = logger.warn.mock.calls[0][0];
        expect(metadata.maxMs).toBeGreaterThanOrEqual(350);
    });

    it('survives a throwing logger and keeps reporting', async () => {
        const logger = {
            log: jest.fn(() => {
                throw new Error('logger down');
            }),
            warn: jest.fn(),
        };
        stop = startEventLoopMonitor({ intervalMs: 50, logger });

        await nextTick(180);

        expect(logger.log.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('stops reporting once stopped', async () => {
        const logger = { log: jest.fn(), warn: jest.fn() };
        stop = startEventLoopMonitor({ intervalMs: 50, logger });
        stop();
        stop = undefined;
        logger.log.mockClear();

        await nextTick(150);

        expect(logger.log).not.toHaveBeenCalled();
    });
});
