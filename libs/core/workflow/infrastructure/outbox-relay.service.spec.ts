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
                'workflow-job-consumer.webhook',
            ].sort(),
        );
    });
});

describe('OutboxRelayService.reapStaleProcessingJobs', () => {
    const DEFAULT_TIMEOUT_MIN = 180;

    let jobRepository: {
        failStaleProcessing: jest.Mock;
        failStaleEphemeralPending: jest.Mock;
    };
    let lock: { release: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let incidentManager: { failHeartbeat: jest.Mock };

    const build = () => {
        jobRepository = {
            failStaleProcessing: jest.fn().mockResolvedValue([]),
            failStaleEphemeralPending: jest.fn().mockResolvedValue([]),
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
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(expected - 5000);
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
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(expected - 5000);
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

describe('OutboxRelayService.reapStaleEphemeralPendingJobs', () => {
    it('fails only expired marked ephemeral PENDING jobs with retry guidance', async () => {
        const failStaleEphemeralPending = jest.fn().mockResolvedValue([
            {
                uuid: 'job-ephemeral-1',
                workflowType: 'CLI_CODE_REVIEW',
                organizationId: 'organization-1',
                startedAt: null,
            },
        ]);
        const lock = { release: jest.fn().mockResolvedValue(undefined) };
        const distributedLock = {
            acquire: jest.fn().mockResolvedValue(lock),
        };
        const service = new OutboxRelayService(
            {} as never,
            {} as never,
            { failStaleEphemeralPending } as never,
            {} as never,
            {} as never,
            { get: jest.fn() } as never,
            distributedLock as never,
            {} as never,
            { failHeartbeat: jest.fn() } as never,
        );

        await service.reapStaleEphemeralPendingJobs();

        expect(failStaleEphemeralPending).toHaveBeenCalledWith({
            olderThan: expect.any(Date),
            lastError:
                'Review context expired before processing. Submit the review again.',
            errorClassification: ErrorClassification.PERMANENT,
        });
        expect(lock.release).toHaveBeenCalledTimes(1);
    });
});
