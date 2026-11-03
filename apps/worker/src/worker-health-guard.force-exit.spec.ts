import { WorkerHealthGuardService } from './worker-health-guard.service';

/**
 * When a graceful shutdown hangs, the force-exit fires after the whole
 * bounded chain (drain + cancels + close + inbox release) and says which
 * budget it fired on, so a killed drain can be told from a hung hook.
 */
describe('WorkerHealthGuardService force-exit', () => {
    const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        if (prev === undefined) delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
    });

    it('exits only after the shutdown budget, logging the budget it fired on', () => {
        jest.useFakeTimers();
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '240000';
        const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
        const exit = jest
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined) as never);
        const guard = new WorkerHealthGuardService(undefined);
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (guard as any).logger = logger;

        (guard as any).exitGracefully(1);

        expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
        jest.advanceTimersByTime(275_000 - 1);
        expect(exit).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(exit).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Graceful shutdown timed out. Force exiting.',
                metadata: expect.objectContaining({
                    exitCode: 1,
                    timeoutMs: 275_000,
                    drainTimeoutMs: 240_000,
                }),
            }),
        );
    });

    it('starts a shutdown only once', () => {
        jest.useFakeTimers();
        const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
        jest.spyOn(process, 'exit').mockImplementation(
            (() => undefined) as never,
        );
        const guard = new WorkerHealthGuardService(undefined);
        (guard as any).logger = { log: jest.fn(), error: jest.fn() };

        (guard as any).exitGracefully(1);
        (guard as any).exitGracefully(1);

        expect(kill).toHaveBeenCalledTimes(1);
    });
});
