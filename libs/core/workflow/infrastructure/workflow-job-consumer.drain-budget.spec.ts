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

    function consumerWithStuckJob() {
        const inboxRepository = {
            releaseAllByInstance: jest.fn().mockResolvedValue(0),
        };
        const consumer = new WorkflowJobConsumer(
            {} as any,
            inboxRepository as any,
            {} as any,
            {} as any,
            {} as any,
        );
        (consumer as any).activeJobs = 1;
        return { consumer, inboxRepository };
    }

    it.each([
        ['out of range', '2400000', 25_000],
        ['in range', '60000', 60_000],
    ])(
        'drains for the shared budget when the variable is %s',
        async (_label, configured, budgetMs) => {
            jest.useFakeTimers();
            process.env.API_WORKER_DRAIN_TIMEOUT_MS = configured;
            const { consumer, inboxRepository } = consumerWithStuckJob();

            const done = consumer.beforeApplicationShutdown('SIGTERM');
            await jest.advanceTimersByTimeAsync(budgetMs - 2_000);
            expect(inboxRepository.releaseAllByInstance).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(3_000);
            await done;
            expect(inboxRepository.releaseAllByInstance).toHaveBeenCalled();
        },
    );
});
