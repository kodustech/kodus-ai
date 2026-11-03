import * as os from 'os';

import { WorkflowJobConsumer } from './workflow-job-consumer.service';

/**
 * The job drain and the worker's force-exit timer read the same budget. A
 * drain longer than the force-exit (an out-of-range
 * API_WORKER_DRAIN_TIMEOUT_MS) was killed before it released this host's
 * inbox locks.
 */
describe('WorkflowJobConsumer drain budget', () => {
    const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;

    afterEach(() => {
        jest.useRealTimers();
        if (prev === undefined) delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
    });

    function consumerWithStuckJob(
        releaseAllByInstance: jest.Mock = jest.fn().mockResolvedValue(0),
    ) {
        const inboxRepository = { releaseAllByInstance };
        const consumer = new WorkflowJobConsumer(
            {} as any,
            inboxRepository as any,
            {} as any,
            {} as any,
            {} as any,
        );
        (consumer as any).activeJobs = 1;
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (consumer as any).logger = logger;
        return { consumer, inboxRepository, logger };
    }

    it.each([
        ['unset', undefined, 25_000],
        ['out of range', '2400000', 25_000],
        ['in range', '60000', 60_000],
    ])(
        'drains for the shared budget when the variable is %s',
        async (_label, configured, budgetMs) => {
            jest.useFakeTimers();
            if (configured === undefined) {
                delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
            } else {
                process.env.API_WORKER_DRAIN_TIMEOUT_MS = configured;
            }
            const { consumer, inboxRepository } = consumerWithStuckJob();

            const done = consumer.beforeApplicationShutdown('SIGTERM');
            await jest.advanceTimersByTimeAsync(budgetMs - 2_000);
            expect(inboxRepository.releaseAllByInstance).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(3_000);
            await done;
            // This host's locks, not anyone else's
            expect(inboxRepository.releaseAllByInstance).toHaveBeenCalledWith(
                os.hostname(),
            );
        },
    );

    it('stops waiting on a hung inbox release, so the connection close still runs', async () => {
        jest.useFakeTimers();
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '5000';
        const { consumer, logger } = consumerWithStuckJob(
            jest.fn(() => new Promise<number>(() => undefined)),
        );

        let finished = false;
        const done = consumer
            .beforeApplicationShutdown('SIGTERM')
            .then(() => (finished = true));
        await jest.advanceTimersByTimeAsync(5_000 + 10_000 - 500);
        expect(finished).toBe(false);

        await jest.advanceTimersByTimeAsync(1_000);
        await done;
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Failed to release inbox locks during shutdown',
            }),
        );
    });
});
