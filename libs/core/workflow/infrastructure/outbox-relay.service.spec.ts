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
                'workflow-job-consumer.cli_code_review',
                'workflow-job-consumer.code_review',
                'workflow-job-consumer.security_scan',
                'workflow-job-consumer.webhook',
                'chat-with-kody-from-git',
            ].sort(),
        );
    });
});

describe('OutboxRelayService.reapStaleProcessingJobs', () => {
    const DEFAULT_TIMEOUT_MIN = 180;

    let jobRepository: {
        failStaleProcessing: jest.Mock;
        countReapedSince: jest.Mock;
    };
    let lock: { release: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let incidentManager: { failHeartbeat: jest.Mock };

    const jobs = (n: number, workflowType = 'CODE_REVIEW') =>
        Array.from({ length: n }, (_, i) => ({
            uuid: `job-${workflowType}-${i}`,
            workflowType,
            organizationId: `org-${i % 2}`,
            startedAt: new Date(),
        }));

    const build = () => {
        jobRepository = {
            failStaleProcessing: jest.fn().mockResolvedValue([]),
            // undefined: no window count available, alert on the pass alone
            countReapedSince: jest.fn().mockResolvedValue(undefined),
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

    it('alerts once when small passes add up past the threshold in the window', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue(jobs(2));
        jobRepository.countReapedSince.mockResolvedValue(5); // 3 before + 2 now

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
        // The window is 60 min, counted on the DB clock (minutes, not a
        // JS Date that would shift with the process time zone).
        expect(jobRepository.countReapedSince).toHaveBeenCalledWith(
            60,
            'Orphaned:',
        );
    });

    it('does not alert again while the window is already past the threshold', async () => {
        const service = build();
        // A pass that alone reaches the threshold: the previous per-pass
        // alert fired on it every time; the window already crossed it.
        jobRepository.failStaleProcessing.mockResolvedValue(jobs(6));
        jobRepository.countReapedSince.mockResolvedValue(12); // 6 before + 6 now

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).not.toHaveBeenCalled();
    });

    it('says what was lost and where to look, without guessing OOM', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue(jobs(6));

        await service.reapStaleProcessingJobs();

        const [url, message] = incidentManager.failHeartbeat.mock.calls[0];
        expect(url).toBe('API_BETTERSTACK_HEARTBEAT_OUTBOX_URL');
        expect(message).toContain('6 workflow jobs lost');
        expect(message).toContain('CODE_REVIEW: 6');
        expect(message).toContain('2 orgs');
        expect(message).toContain('StallWatchdog');
        expect(message).toContain('monitor=workflow_job_loss');
        expect(message).not.toMatch(/OOM|node pressure/);
    });

    it('still alerts on the pass alone when the window count fails, and says so', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue(jobs(6));
        jobRepository.countReapedSince.mockRejectedValue(new Error('db slow'));

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
        const message = incidentManager.failHeartbeat.mock.calls[0][1];
        expect(message).toContain('6 workflow jobs lost in this reaper pass');
        expect(message).toContain('window count is unavailable');
        expect(message).not.toContain('in the last 60 min');
        expect(message).not.toContain('lostInWindow=');
    });

    it('counts a workflow type named like an Object member as any other', async () => {
        const service = build();
        jobRepository.failStaleProcessing.mockResolvedValue(
            jobs(6, 'constructor'),
        );

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat.mock.calls[0][1]).toContain(
            'constructor: 6',
        );
    });

    it('does not hold the reaper pass (and its lock) on the heartbeat', async () => {
        const service = build();
        // 2 jobs: below the old per-pass threshold, so only the window count
        // (5) makes this pass alert; the pre-#2615 reaper never alerted here.
        jobRepository.failStaleProcessing.mockResolvedValue(jobs(2));
        jobRepository.countReapedSince.mockResolvedValue(5);
        incidentManager.failHeartbeat.mockReturnValue(new Promise(() => {}));

        await service.reapStaleProcessingJobs();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
        expect(lock.release).toHaveBeenCalledTimes(1);
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

describe('OutboxRelayService names the lost work', () => {
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

    it('says when the lost jobs started and which PRs lost their review', async () => {
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
                        job(5, 8133, '2026-11-19T13:29:58Z'),
                    ]),
                countReapedSince: jest.fn().mockResolvedValue(5),
            },
        });

        await service.reapStaleProcessingJobs();

        const text = incidentManager.failHeartbeat.mock.calls[0][1];
        expect(text).toContain('Started between 13:20:41Z and 13:29:58Z');
        expect(text).toContain('wellvector/wellvector-app#8129 (2)');
        expect(text).toContain("this alert's host only ran the reaper");
    });

    it('logs the workers that held the reclaimed locks, read before the reclaim clears them, and raises no incident', async () => {
        const order: string[] = [];
        const consumer = 'workflow-job-consumer.code_review';
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn(async (consumerId: string) => {
                order.push(`holders:${consumerId}`);
                return consumerId === consumer
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
                    return consumerId === consumer ? 9 : 0;
                },
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });
        const logger = (service as any).logger;
        logger.error.mockClear();

        await service.reclaimStaleInbox();

        expect(order.indexOf(`holders:${consumer}`)).toBeLessThan(
            order.indexOf(`reclaim:${consumer}`),
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(
                    'held by ip-10-100-1-2.ec2.internal (9), taken between 11:30:12Z and 11:39:55Z',
                ),
            }),
        );
        expect(incidentManager.failHeartbeat).not.toHaveBeenCalled();
    });

    it.each([
        'workflow-events-stage-completed',
        'workflow-events-ast',
        'chat-with-kody-from-git',
    ])(
        'raises the incident for %s, whose loss no job reaper reports',
        async (consumer) => {
            const inboxRepository = {
                staleHoldersByConsumer: jest.fn().mockResolvedValue([]),
                reclaimStaleMessagesByConsumer: jest.fn(
                    async (consumerId: string) =>
                        consumerId === consumer ? 7 : 0,
                ),
            };
            const { service, incidentManager } = build({ inboxRepository });

            await service.reclaimStaleInbox();

            expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);
            const [, message] = incidentManager.failHeartbeat.mock.calls[0];
            expect(message).toContain(
                `High inbox reclaim rate for ${consumer}`,
            );
            expect(message).toContain('monitor=inbox_reclaim_rate');
        },
    );

    it('raises no incident for an event consumer at or under the rate', async () => {
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn().mockResolvedValue([]),
            reclaimStaleMessagesByConsumer: jest.fn(
                async (consumerId: string) =>
                    consumerId === 'workflow-events-ast' ? 5 : 0,
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });

        await service.reclaimStaleInbox();

        expect(incidentManager.failHeartbeat).not.toHaveBeenCalled();
    });

    it('raises one reclaim incident per consumer per loss window, not one per pass', async () => {
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn().mockResolvedValue([]),
            reclaimStaleMessagesByConsumer: jest.fn(
                async (consumerId: string) =>
                    consumerId === 'workflow-events-ast' ? 7 : 0,
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });
        const now = jest.spyOn(Date, 'now');
        const start = Date.parse('2026-11-20T12:00:00Z');
        try {
            now.mockReturnValue(start);
            await service.reclaimStaleInbox();
            now.mockReturnValue(start + 5 * 60_000);
            await service.reclaimStaleInbox();
            expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(1);

            now.mockReturnValue(start + 61 * 60_000);
            await service.reclaimStaleInbox();
            expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    it("keeps each consumer's window apart: one consumer's alert never silences another's", async () => {
        let lossy = ['workflow-events-ast'];
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn().mockResolvedValue([]),
            reclaimStaleMessagesByConsumer: jest.fn(
                async (consumerId: string) =>
                    lossy.includes(consumerId) ? 7 : 0,
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });

        await service.reclaimStaleInbox();
        lossy = ['workflow-events-ast', 'chat-with-kody-from-git'];
        await service.reclaimStaleInbox();

        const alerted = incidentManager.failHeartbeat.mock.calls.map(
            ([, message]: [string, string]) =>
                message.match(/rate for (\S+):/)?.[1],
        );
        expect(alerted).toEqual([
            'workflow-events-ast',
            'chat-with-kody-from-git',
        ]);
    });

    it('tries again on the next pass when the incident was not delivered', async () => {
        const inboxRepository = {
            staleHoldersByConsumer: jest.fn().mockResolvedValue([]),
            reclaimStaleMessagesByConsumer: jest.fn(
                async (consumerId: string) =>
                    consumerId === 'workflow-events-ast' ? 7 : 0,
            ),
        };
        const { service, incidentManager } = build({ inboxRepository });
        incidentManager.failHeartbeat.mockRejectedValueOnce(
            new Error('betterstack down'),
        );

        await service.reclaimStaleInbox();
        await new Promise((resolve) => setImmediate(resolve));
        await service.reclaimStaleInbox();

        expect(incidentManager.failHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('still reclaims when the holders cannot be read', async () => {
        const inboxRepository = {
            staleHoldersByConsumer: jest
                .fn()
                .mockRejectedValue(new Error('db down')),
            reclaimStaleMessagesByConsumer: jest.fn().mockResolvedValue(7),
        };
        const { service } = build({ inboxRepository });

        await service.reclaimStaleInbox();

        expect(
            inboxRepository.reclaimStaleMessagesByConsumer,
        ).toHaveBeenCalled();
    });
});
