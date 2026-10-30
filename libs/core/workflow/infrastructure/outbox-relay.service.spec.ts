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
    let messageBroker: { publishMessage: jest.Mock };
    let outboxRepository: { create: jest.Mock };

    const build = () => {
        messageBroker = {
            publishMessage: jest.fn().mockResolvedValue(undefined),
        };
        outboxRepository = {
            create: jest.fn().mockResolvedValue(undefined),
        };
        jobRepository = {
            findStaleProcessing: jest.fn().mockResolvedValue([]),
            requeueStaleJobs: jest.fn().mockResolvedValue([]),
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
            outboxRepository as any, // outboxRepository
            {} as any, // inboxRepository
            jobRepository as any, // jobRepository
            messageBroker as any, // messageBroker
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
        jobRepository.requeueStaleJobs.mockResolvedValue(['job-alive-claim']);

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

    it('gives a lease-less PROCESSING row its own reason, not a lease that never existed', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                // A workflow type that never took a lease: failing it is the
                // legacy path, but the incident text must not claim the lease
                // expired, which is the guess that made #1830 hard to read.
                uuid: 'job-never-leased',
                workflowType: 'CHECK_IMPLEMENTATION',
                organizationId: 'org-1',
                startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
                leaseExpiresAt: null,
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.failStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        expect(jobRepository.requeueStaleJobs).not.toHaveBeenCalled();
        expect(jobRepository.failStaleJobs).toHaveBeenCalledTimes(1);
        const arg = jobRepository.failStaleJobs.mock.calls[0][0];
        expect(arg.uuids).toEqual(['job-never-leased']);
        expect(arg.lastError).not.toContain('lease expired');
        expect(arg.lastError).toContain('without a lease');
    });

    it('keeps the two dead rows apart in one reap: budget spent, and never leased', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-budget-spent',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 1,
                maxRetries: 1,
            },
            {
                uuid: 'job-never-leased',
                workflowType: 'WEBHOOK',
                organizationId: 'org-2',
                startedAt: new Date(),
                leaseExpiresAt: null,
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.failStaleJobs.mockResolvedValue(1);

        await service.reapStaleProcessingJobs();

        expect(jobRepository.failStaleJobs).toHaveBeenCalledTimes(2);
        const byUuid = new Map(
            jobRepository.failStaleJobs.mock.calls.map((call: any[]) => [
                call[0].uuids[0],
                call[0].lastError,
            ]),
        );
        expect(byUuid.get('job-budget-spent')).toContain('lease expired');
        expect(byUuid.get('job-budget-spent')).toContain(
            'Retry budget exhausted',
        );
        expect(byUuid.get('job-never-leased')).toContain('without a lease');
        expect(byUuid.get('job-never-leased')).not.toContain('lease expired');
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
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(expected - 5000);
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
        expect(arg.olderThan.getTime()).toBeGreaterThanOrEqual(expected - 5000);
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
        jobRepository.requeueStaleJobs.mockResolvedValue([
            'job-1',
            'job-2',
            'job-3',
            'job-4',
            'job-5',
            'job-6',
        ]);

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
        jobRepository.requeueStaleJobs.mockResolvedValue(['job-1']);

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
        jobRepository.requeueStaleJobs.mockResolvedValue(['job-impl']);

        await service.reapStaleProcessingJobs();

        // retryCount 0 < maxRetries 1 → still has its one retry left.
        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledTimes(1);
        expect(jobRepository.requeueStaleJobs.mock.calls[0][0].uuids).toEqual([
            'job-impl',
        ]);
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
        expect(jobRepository.failStaleJobs.mock.calls[0][0].uuids).toEqual([
            'job-dead',
        ]);
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
        jobRepository.requeueStaleJobs.mockResolvedValue(['job-retry']);
        jobRepository.failStaleJobs.mockRejectedValue(new Error('db down'));

        await service.reapStaleProcessingJobs();

        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledTimes(1);
        expect(jobRepository.requeueStaleJobs.mock.calls[0][0].uuids).toEqual([
            'job-retry',
        ]);
    });

    it('queues one outbox resume message per requeued job, so the relay can retry the publish', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-code',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
            {
                uuid: 'job-impl',
                workflowType: 'CHECK_IMPLEMENTATION',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue([
            'job-code',
            'job-impl',
        ]);

        await service.reapStaleProcessingJobs();

        // A row in the outbox, not a publish: the broker failing here used to
        // leave the job PENDING with no message and nothing to re-drive it.
        expect(outboxRepository.create).toHaveBeenCalledTimes(2);
        expect(messageBroker.publishMessage).not.toHaveBeenCalled();
        const rows = outboxRepository.create.mock.calls.map(
            (call: any[]) => call[0],
        );
        expect(rows.map((row) => row.routingKey)).toEqual([
            'workflow.jobs.resumed.CODE_REVIEW',
            'workflow.jobs.resumed.CHECK_IMPLEMENTATION',
        ]);
        // Each row envelopes the mutated jobId and a fresh messageId, so the
        // inbox claim is not a no-op, and names the job and its type in the
        // nested payload the relay reads for the AMQP headers.
        expect(rows.map((row) => row.jobId)).toEqual(['job-code', 'job-impl']);
        for (const row of rows) {
            expect(row.payload.event_name).toBe('workflow.jobs.resumed');
            expect(row.payload.payload.jobId).toBe(row.jobId);
            expect(row.payload.payload.workflowType).toBeDefined();
            expect(row.payload.messageId).toMatch(/^reclaim-/);
            expect(row.nextAttemptAt).toBeInstanceOf(Date);
        }
    });

    it('does not republish a requeued uuid that the repo did not return (TOCTOU guard)', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-code',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        // The guarded UPDATE returned no rows (it flipped none).
        jobRepository.requeueStaleJobs.mockResolvedValue([]);

        await service.reapStaleProcessingJobs();

        expect(messageBroker.publishMessage).not.toHaveBeenCalled();
    });

    it('passes the batch organization ids to the requeue write (tenant traceability)', async () => {
        const service = build();
        jobRepository.findStaleProcessing.mockResolvedValue([
            {
                uuid: 'job-a',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
            {
                uuid: 'job-b',
                workflowType: 'CHECK_IMPLEMENTATION',
                organizationId: 'org-2',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
            {
                uuid: 'job-c',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() - 1000),
                retryCount: 0,
                maxRetries: 3,
            },
        ]);
        jobRepository.requeueStaleJobs.mockResolvedValue([
            'job-a',
            'job-b',
            'job-c',
        ]);

        await service.reapStaleProcessingJobs();

        // Deduplicated, so the repository's log line can be filtered per tenant
        // instead of carrying a bare uuid list.
        expect(jobRepository.requeueStaleJobs).toHaveBeenCalledWith(
            expect.objectContaining({
                uuids: ['job-a', 'job-b', 'job-c'],
                organizationIds: ['org-1', 'org-2'],
            }),
        );
    });

    it('keeps queueing when one outbox write rejects — the reap report still runs', async () => {
        const service = build();
        const jobs = Array.from({ length: 6 }, (_, i) => ({
            uuid: `job-${i}`,
            workflowType: 'CODE_REVIEW',
            organizationId: 'org-1',
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() - 1000),
            retryCount: 0,
            maxRetries: 3,
        }));
        jobRepository.findStaleProcessing.mockResolvedValue(jobs);
        jobRepository.requeueStaleJobs.mockResolvedValue(
            jobs.map((j) => j.uuid),
        );
        // One write rejection must not abort the batch nor the cycle: with
        // Promise.all the rejection propagated to the outer catch, so the
        // remaining rows were never written and the high-reap incident report
        // was skipped entirely.
        outboxRepository.create
            .mockRejectedValueOnce(new Error('outbox is down'))
            .mockResolvedValue(undefined);

        await expect(
            service.reapStaleProcessingJobs(),
        ).resolves.toBeUndefined();

        expect(outboxRepository.create).toHaveBeenCalledTimes(6);
        // 6 reclaimed > high-reap threshold (5): the cycle reached its report.
        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('isolates a synchronous outbox throw to its own job', async () => {
        const service = build();
        const jobs = Array.from({ length: 3 }, (_, i) => ({
            uuid: `job-sync-${i}`,
            workflowType: 'CODE_REVIEW',
            organizationId: 'org-1',
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() - 1000),
            retryCount: 0,
            maxRetries: 3,
        }));
        jobRepository.findStaleProcessing.mockResolvedValue(jobs);
        jobRepository.requeueStaleJobs.mockResolvedValue(
            jobs.map((j) => j.uuid),
        );
        // A client that throws synchronously used to break out of the .map()
        // that built the write list, so no later job was attempted.
        outboxRepository.create
            .mockImplementationOnce(() => {
                throw new Error('outbox connection closed');
            })
            .mockResolvedValue(undefined);

        await expect(
            service.reapStaleProcessingJobs(),
        ).resolves.toBeUndefined();

        expect(outboxRepository.create).toHaveBeenCalledTimes(3);
    });
});
