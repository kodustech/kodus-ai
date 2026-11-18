import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import {
    INBOX_REAPER_CONSUMER_TIMEOUTS,
    OutboxRelayService,
} from './outbox-relay.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

describe('INBOX_REAPER_CONSUMER_TIMEOUTS', () => {
    it('covers every workflow consumer that claims inbox messages', () => {
        expect(Object.keys(INBOX_REAPER_CONSUMER_TIMEOUTS).sort()).toEqual(
            [
                'workflow-events-ast',
                'workflow-events-stage-completed',
                'workflow-job-consumer.ast_graph_build',
                'workflow-job-consumer.ast_graph_incremental',
                'workflow-job-consumer.check_implementation',
                'workflow-job-consumer.code_review',
                'workflow-job-consumer.security_scan',
                'workflow-job-consumer.webhook',
            ].sort(),
        );
    });
});

describe('OutboxRelayService.reapStaleProcessingJobs', () => {
    const DEFAULT_TIMEOUT_MIN = 180;

    let jobRepository: { failStaleProcessing: jest.Mock };
    let lock: { release: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let incidentManager: { failHeartbeat: jest.Mock };

    const build = () => {
        jobRepository = {
            failStaleProcessing: jest.fn().mockResolvedValue([]),
        };
        lock = { release: jest.fn().mockResolvedValue(undefined) };
        distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lock),
        };
        incidentManager = {
            failHeartbeat: jest.fn().mockResolvedValue(undefined),
        };

        const configService = { get: jest.fn() };

        return new OutboxRelayService(
            {} as any, // outboxRepository
            {} as any, // inboxRepository
            jobRepository as any, // jobRepository
            {} as any, // messageBroker
            {} as any, // observability
            configService as any,
            distributedLockService as any,
            {} as any, // sandboxLeaseManager
            incidentManager as any,
        );
    };

    beforeEach(() => {
        delete process.env.WORKFLOW_STALE_JOB_TIMEOUT_MINUTES;
    });

    it('reaps PROCESSING jobs older than the timeout as FAILED/PERMANENT', async () => {
        const service = build();
        const before = Date.now();

        await service.reapStaleProcessingJobs();

        expect(distributedLockService.acquire).toHaveBeenCalledTimes(1);
        expect(jobRepository.failStaleProcessing).toHaveBeenCalledTimes(1);

        const arg = jobRepository.failStaleProcessing.mock.calls[0][0];
        expect(arg.errorClassification).toBe(ErrorClassification.PERMANENT);
        expect(typeof arg.lastError).toBe('string');
        expect(arg.lastError.length).toBeGreaterThan(0);

        // cutoff ~ now - 180min (allow a generous window for test slowness)
        const expected = before - DEFAULT_TIMEOUT_MIN * 60 * 1000;
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(
            expected - 5000,
        );
        expect(arg.olderThan.getTime()).toBeLessThanOrEqual(expected + 5000);

        expect(lock.release).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the distributed lock is not acquired', async () => {
        const service = build();
        distributedLockService.acquire.mockResolvedValue(null);

        await service.reapStaleProcessingJobs();

        expect(jobRepository.failStaleProcessing).not.toHaveBeenCalled();
    });

    it('honors WORKFLOW_STALE_JOB_TIMEOUT_MINUTES override', async () => {
        process.env.WORKFLOW_STALE_JOB_TIMEOUT_MINUTES = '30';
        const service = build();
        const before = Date.now();

        await service.reapStaleProcessingJobs();

        const arg = jobRepository.failStaleProcessing.mock.calls[0][0];
        const expected = before - 30 * 60 * 1000;
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(
            expected - 5000,
        );
        expect(arg.olderThan.getTime()).toBeLessThanOrEqual(expected + 5000);
    });

    it('raises a high-reap-rate incident when many jobs are orphaned', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue(
            Array.from({ length: 6 }, (_, i) => ({
                uuid: `job-${i}`,
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
            })),
        );

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('does not raise an incident for a small reap batch', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-1',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
            },
        ]);

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).not.toHaveBeenCalled();
    });

    it('always releases the lock, even when the repository throws', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockRejectedValue(
            new Error('db down'),
        );

        await service.reapStaleProcessingJobs();

        expect(lock.release).toHaveBeenCalledTimes(1);
    });
});

describe('OutboxRelayService relay loop across a broker outage', () => {
    const readyMessage = {
        uuid: 'outbox-1',
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.created.CODE_REVIEW',
        attempts: 0,
        payload: { payload: { jobId: 'job-1', correlationId: 'corr-1' } },
    };

    let brokerConnected: boolean;
    let outboxRepository: {
        claimBatch: jest.Mock;
        markAsSent: jest.Mock;
        markAsFailed: jest.Mock;
    };
    let messageBroker: { isConnected: jest.Mock; publishMessage: jest.Mock };
    let service: OutboxRelayService;

    beforeEach(() => {
        jest.useFakeTimers();
        brokerConnected = false;
        outboxRepository = {
            // The row stays READY until a cycle claims it.
            claimBatch: jest
                .fn()
                .mockResolvedValueOnce([readyMessage])
                .mockResolvedValue([]),
            markAsSent: jest.fn().mockResolvedValue(undefined),
            markAsFailed: jest.fn().mockResolvedValue(undefined),
        };
        messageBroker = {
            isConnected: jest.fn(() => brokerConnected),
            publishMessage: jest.fn().mockResolvedValue(undefined),
        };
        const observability = {
            runInSpan: jest.fn((_name, fn) => fn({ setAttributes: jest.fn() })),
        };

        service = new OutboxRelayService(
            outboxRepository as any,
            {} as any, // inboxRepository
            {} as any, // jobRepository
            messageBroker as any,
            observability as any,
            { get: jest.fn() } as any,
            {} as any, // distributedLockService
            {} as any, // sandboxLeaseManager
        );
    });

    afterEach(() => {
        service.onModuleDestroy();
        jest.useRealTimers();
    });

    it('keeps polling while the broker is down and publishes the READY message once it is back', async () => {
        service.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(30_000);

        expect(messageBroker.isConnected.mock.calls.length).toBeGreaterThan(1);
        expect(outboxRepository.claimBatch).not.toHaveBeenCalled();
        expect(messageBroker.publishMessage).not.toHaveBeenCalled();

        brokerConnected = true;
        await jest.advanceTimersByTimeAsync(3_000);

        expect(messageBroker.publishMessage).toHaveBeenCalledTimes(1);
        expect(messageBroker.publishMessage.mock.calls[0][0]).toEqual({
            exchange: readyMessage.exchange,
            routingKey: readyMessage.routingKey,
        });
        expect(outboxRepository.markAsSent).toHaveBeenCalledWith('outbox-1');
        expect(outboxRepository.markAsFailed).not.toHaveBeenCalled();
    });

    it('starts a single loop even when bootstrapped twice', async () => {
        service.onApplicationBootstrap();
        service.onApplicationBootstrap();

        expect(messageBroker.isConnected).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(30_000);
        const cycles = messageBroker.isConnected.mock.calls.length;
        // 1s, 2s, then 3s apart: ~11 cycles in 30 s for one loop.
        expect(cycles).toBeLessThanOrEqual(12);
    });

    it('reports its liveness: not started, running with a fresh cycle, stopped', async () => {
        expect(service.getLiveness()).toEqual({
            state: 'not_started',
            lastCycleAt: undefined,
        });

        service.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(10_000);

        const running = service.getLiveness();
        expect(running.state).toBe('running');
        expect(Date.now() - running.lastCycleAt!).toBeLessThanOrEqual(3_000);

        service.onModuleDestroy();
        expect(service.getLiveness().state).toBe('stopped');
    });

    it('stops advancing its last cycle while a cycle hangs', async () => {
        service.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(5_000);

        brokerConnected = true;
        outboxRepository.claimBatch
            .mockReset()
            .mockReturnValue(new Promise(() => undefined));
        await jest.advanceTimersByTimeAsync(3_000);
        const stuckAt = service.getLiveness().lastCycleAt!;

        await jest.advanceTimersByTimeAsync(5 * 60_000);

        expect(service.getLiveness().lastCycleAt).toBe(stuckAt);
        expect(Date.now() - stuckAt).toBeGreaterThanOrEqual(5 * 60_000);
    });
});
