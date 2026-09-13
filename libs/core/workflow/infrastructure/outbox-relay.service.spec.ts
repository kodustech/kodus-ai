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
        findStaleProcessing: jest.Mock;
        requeueStaleJobs: jest.Mock;
        failStaleJobs: jest.Mock;
    };
    let lock: { release: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let incidentManager: { failHeartbeat: jest.Mock };

    const build = () => {
        jobRepository = {
            findStaleProcessing: jest.fn().mockResolvedValue([]),
            requeueStaleJobs: jest.fn().mockResolvedValue(0),
            failStaleJobs: jest.fn().mockResolvedValue(0),
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

    it('reclaims to PENDING with a retry when the lease expired and budget remains, and does NOT permanently fail', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-alive-claim',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        expect(distributedLockService.acquire).toHaveBeenCalledTimes(1);
        expect(jobRepository.findStaleProcessing).toHaveBeenCalledTimes(1);
        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledTimes(1);
        expect(jobRepository.failStaleJobs).not.toHaveBeenCalled();
        const arg = jobRepository.requeueStaleJobs.mock.calls[0][0];
        expect(arg.uuids).toEqual(['job-alive-claim']);
    });

    it('permanently fails a stale job whose retry budget is exhausted', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-dead',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 3,
                maxRetries: 3,
            },
        ]);
        jobRepository.failStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        expect(jobRepository.requeueStaleJobs).not.toHaveBeenCalled();
        expect(jobRepository.failStaleJobs).toHaveBeenCalledTimes(1);
        const arg = jobRepository.failStaleJobs.mock.calls[0][0];
        expect(arg.uuids).toEqual(['job-dead']);
        expect(arg.errorClassification).toBe(ErrorClassification.PERMANENT);
    });

    it('passes an age cutoff ~ now - 180min for legacy rows', async () => {
        const service = build();
        const before = Date.now();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-legacy',
                workflowType: 'CODE_REVIEW',
                organizationId: null,
                startedAt: new Date(),
                leaseExpiresAt: null,
                retryCount: 0,
                maxRetries: 3,
            },
        ]);

        await service.reapStaleProcessingJobs();

        const arg = jobRepository.findStaleProcessing.mock.calls[0][0];
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

        expect(jobRepository.findStaleProcessing).not.toHaveBeenCalled();
    });

    it('honors WORKFLOW_STALE_JOB_TIMEOUT_MINUTES override', async () => {
        process.env.WORKFLOW_STALE_JOB_TIMEOUT_MINUTES = '30';
        const service = build();
        const before = Date.now();

        await service.reapStaleProcessingJobs();

        const arg = jobRepository.findStaleProcessing.mock.calls[0][0];
        const expected = before - 30 * 60 * 1000;
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(
            expected - 5000,
        );
        expect(arg.olderThan.getTime()).toBeLessThanOrEqual(expected + 5000);
    });

    it('raises a high-reap-rate incident when many jobs are reclaimed', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue(
            Array.from({ length: 6 }, (_, i) => ({
                uuid: `job-${i}`,
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            })),
        );
        jobRepository.requeueStaleJobs.mockResolvedValue(6);

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('does not raise an incident for a small reap batch', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-1',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).not.toHaveBeenCalled();
    });

    it('always releases the lock, even when the repository throws', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockRejectedValue(
            new Error('db down'),
        );

        await service.reapStaleProcessingJobs();

        expect(lock.release).toHaveBeenCalledTimes(1);
    });

    it('requeues (not fails) a first-time stale job with maxRetries:1', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-impl',
                workflowType: 'CHECK_IMPLEMENTATION',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 1,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        // retryCount 0 < maxRetries 1 → still has its one retry left.
        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledTimes(1);
        expect(
            jobRepository.requeueStaleJobs.mock.calls[0][0].uuids,
        ).toEqual(['job-impl']);
        expect(jobRepository.failStaleJobs).not.toHaveBeenCalled();
    });

    it('runs the dead-letter write even when the requeue write rejects', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-retry',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
            {
                uuid: 'job-dead',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 3,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockRejectedValue(new Error('db down'));
        jobRepository.failStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        // The rejection on one write must not skip the other (Promise.allSettled).
        expect(jobRepository.failStaleJobs).toHaveBeenCalledTimes(1);
        expect(
            jobRepository.failStaleJobs.mock.calls[0][0].uuids,
        ).toEqual(['job-dead']);
    });

    it('runs the requeue write even when the dead-letter write rejects', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-retry',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
            {
                uuid: 'job-dead',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 3,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue(1);
        jobRepository.failStaleJobs.mockRejectedValue(new Error('db down'));

        await service.reapStaleProcessingJobs();

        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledTimes(1);
        expect(
            jobRepository.requeueStaleJobs.mock.calls[0][0].uuids,
        ).toEqual(['job-retry']);
    });
});
