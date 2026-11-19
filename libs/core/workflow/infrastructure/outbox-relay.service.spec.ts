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

describe('OutboxRelayService alerts about lost work', () => {
    const build = (over: { jobRepository?: any; inboxRepository?: any }) => {
        const lock = { release: jest.fn().mockResolvedValue(undefined) };
        const incidentManager = {
            failHeartbeat: jest.fn().mockResolvedValue(undefined),
        };
        const service = new OutboxRelayService(
            {} as any,
            over.inboxRepository ?? ({} as any),
            over.jobRepository ?? ({} as any),
            {} as any,
            {
                runInSpan: (_n: string, fn: (s: any) => any) =>
                    fn({ setAttributes: jest.fn(), setAttribute: jest.fn() }),
            } as any,
            { get: jest.fn() } as any,
            { acquire: jest.fn().mockResolvedValue(lock) } as any,
            {} as any,
            incidentManager as any,
        );
        return { service, incidentManager };
    };

    it('names when the reaped jobs started and which PRs lost their review', async () => {
        const job = (i: number, pr: number, startedAt: string) => ({
            uuid: `job-${i}`,
            workflowType: 'CODE_REVIEW',
            organizationId: 'org-1',
            startedAt: new Date(startedAt),
            payload: {
                platformType: 'GITHUB',
                codeManagementPayload: {
                    pull_request: { number: pr },
                    repository: { full_name: 'wellvector/wellvector-app' },
                },
            },
        });
        const { service, incidentManager } = build({
            jobRepository: {
                failStaleProcessing: jest
                    .fn()
                    .mockResolvedValue([
                        job(1, 8129, '2026-11-19T13:20:41Z'),
                        job(2, 8129, '2026-11-19T13:25:00Z'),
                        job(3, 8130, '2026-11-19T13:26:00Z'),
                        job(4, 8131, '2026-11-19T13:27:00Z'),
                        job(5, 8132, '2026-11-19T13:28:00Z'),
                        job(6, 8133, '2026-11-19T13:29:58Z'),
                    ]),
            },
        });

        await service.reapStaleProcessingJobs();

        const text = incidentManager.failHeartbeat.mock.calls[0][1];
        expect(text).toContain('started between 13:20:41Z and 13:29:58Z');
        expect(text).toContain('wellvector/wellvector-app#8129 (2)');
        expect(text).toContain('the sending host only ran the reaper');
    });

    it('names the workers that held the reclaimed messages, read before the reclaim clears them', async () => {
        const order: string[] = [];
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn(async (consumerId: string) => {
                order.push(`holders:${consumerId}`);
                return consumerId === 'workflow-job-consumer.code_review'
                    ? [
                          {
                              lockedBy: 'ip-10-100-1-2.ec2.internal',
                              count: 9,
                              oldestLockedAt: '2026-11-19T11:30:12.000Z',
                              newestLockedAt: '2026-11-19T11:39:55.000Z',
                          },
                      ]
                    : [];
            }),
            reclaimStaleMessagesByConsumer: jest.fn(
                async (consumerId: string) => {
                    order.push(`reclaim:${consumerId}`);
                    return consumerId === 'workflow-job-consumer.code_review'
                        ? 9
                        : 0;
                },
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });

        await service.reclaimStaleInbox();

        const consumer = 'workflow-job-consumer.code_review';
        expect(order.indexOf(`holders:${consumer}`)).toBeLessThan(
            order.indexOf(`reclaim:${consumer}`),
        );
        const text = incidentManager.failHeartbeat.mock.calls[0][1];
        expect(text).toContain('over 150 min');
        expect(text).toContain('between 11:30:12Z and 11:39:55Z');
        expect(text).toContain('ip-10-100-1-2.ec2.internal (9)');
    });

    it('still reclaims when the holders cannot be read', async () => {
        const inboxRepository = {
            staleHoldersByConsumer: jest
                .fn()
                .mockRejectedValue(new Error('db down')),
            reclaimStaleMessagesByConsumer: jest.fn().mockResolvedValue(7),
        };
        const { service, incidentManager } = build({ inboxRepository });

        await service.reclaimStaleInbox();

        expect(
            inboxRepository.reclaimStaleMessagesByConsumer,
        ).toHaveBeenCalled();
        expect(incidentManager.failHeartbeat).toHaveBeenCalled();
    });
});
