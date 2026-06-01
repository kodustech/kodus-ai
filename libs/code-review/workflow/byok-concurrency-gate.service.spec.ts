import { ByokConcurrencyGateService } from './byok-concurrency-gate.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 5 * 60_000; // 300_000
const MAX_DEFERRALS = 10;

type Lock = { release: jest.Mock };

const makeJob = (overrides: Partial<any> = {}): any => ({
    id: 'job-1',
    correlationId: 'corr-1',
    workflowType: 'code_review',
    handlerType: 'agent_review',
    organizationAndTeamData: {
        organizationId: 'org-1',
        teamId: 'team-1',
    },
    metadata: {},
    ...overrides,
});

const makeMainConfig = (overrides: Partial<any> = {}): any => ({
    provider: 'anthropic',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-5',
    maxConcurrentRequests: 3,
    ...overrides,
});

describe('ByokConcurrencyGateService', () => {
    let service: ByokConcurrencyGateService;
    let orgParamsService: { findByKey: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let jobRepository: { update: jest.Mock };
    let outboxRepository: { create: jest.Mock };
    let messageBroker: { transformMessageToMessageBroker: jest.Mock };

    beforeEach(() => {
        orgParamsService = { findByKey: jest.fn() };
        distributedLockService = { acquire: jest.fn() };
        jobRepository = { update: jest.fn().mockResolvedValue(undefined) };
        outboxRepository = { create: jest.fn().mockResolvedValue(undefined) };
        messageBroker = {
            transformMessageToMessageBroker: jest.fn(
                ({ message }) => message as unknown,
            ),
        };

        service = new ByokConcurrencyGateService(
            orgParamsService as any,
            distributedLockService as any,
            jobRepository as any,
            outboxRepository as any,
            messageBroker as any,
        );
    });

    describe('tryEnter — short circuits to unlimited', () => {
        it('returns unlimited when no organizationId is on the job', async () => {
            const result = await service.tryEnter(
                makeJob({ organizationAndTeamData: null }),
            );
            expect(result).toEqual({ kind: 'unlimited' });
            expect(orgParamsService.findByKey).not.toHaveBeenCalled();
        });

        it('returns unlimited when there is no BYOK config', async () => {
            orgParamsService.findByKey.mockResolvedValue(null);
            const result = await service.tryEnter(makeJob());
            expect(result).toEqual({ kind: 'unlimited' });
        });

        it('returns unlimited when maxConcurrentRequests is 0 or unset', async () => {
            orgParamsService.findByKey.mockResolvedValue({
                configValue: { main: makeMainConfig({ maxConcurrentRequests: 0 }) },
            });

            const result = await service.tryEnter(makeJob());
            expect(result).toEqual({ kind: 'unlimited' });
        });

        it('returns unlimited when BYOK lookup throws (graceful degradation)', async () => {
            orgParamsService.findByKey.mockRejectedValue(new Error('db down'));
            const result = await service.tryEnter(makeJob());
            expect(result).toEqual({ kind: 'unlimited' });
        });
    });

    describe('tryEnter — slot acquisition', () => {
        beforeEach(() => {
            orgParamsService.findByKey.mockResolvedValue({
                configValue: { main: makeMainConfig({ maxConcurrentRequests: 3 }) },
            });
        });

        it('returns acquired with the lock when slot 0 is free', async () => {
            const lock: Lock = { release: jest.fn() };
            distributedLockService.acquire.mockResolvedValueOnce(lock);

            const result = await service.tryEnter(makeJob());

            expect(result).toEqual({ kind: 'acquired', lock });
            expect(distributedLockService.acquire).toHaveBeenCalledTimes(1);
            expect(distributedLockService.acquire.mock.calls[0][0]).toMatch(
                /:slot:0$/,
            );
        });

        it('iterates through slots until one is free', async () => {
            const lock: Lock = { release: jest.fn() };
            distributedLockService.acquire
                .mockResolvedValueOnce(null) // slot 0 busy
                .mockResolvedValueOnce(null) // slot 1 busy
                .mockResolvedValueOnce(lock); // slot 2 free

            const result = await service.tryEnter(makeJob());

            expect(result).toEqual({ kind: 'acquired', lock });
            expect(distributedLockService.acquire).toHaveBeenCalledTimes(3);
            expect(distributedLockService.acquire.mock.calls[2][0]).toMatch(
                /:slot:2$/,
            );
        });

        it('defers the job when all 3 slots are busy', async () => {
            distributedLockService.acquire.mockResolvedValue(null);

            const result = await service.tryEnter(makeJob());

            expect(result.kind).toBe('deferred');
            if (result.kind !== 'deferred') return;
            expect(result.deferredCount).toBe(1);
            expect(result.delayMs).toBe(BASE_DELAY_MS);
            expect(distributedLockService.acquire).toHaveBeenCalledTimes(3);
        });
    });

    describe('tryEnter — backoff schedule', () => {
        beforeEach(() => {
            orgParamsService.findByKey.mockResolvedValue({
                configValue: { main: makeMainConfig({ maxConcurrentRequests: 1 }) },
            });
            distributedLockService.acquire.mockResolvedValue(null);
        });

        it.each([
            { prior: 0, expectedDelay: BASE_DELAY_MS, expectedCount: 1 }, // 15s
            { prior: 1, expectedDelay: 2 * BASE_DELAY_MS, expectedCount: 2 }, // 30s
            { prior: 2, expectedDelay: 4 * BASE_DELAY_MS, expectedCount: 3 }, // 60s
            { prior: 3, expectedDelay: 8 * BASE_DELAY_MS, expectedCount: 4 }, // 120s
            { prior: 4, expectedDelay: 16 * BASE_DELAY_MS, expectedCount: 5 }, // 240s
            { prior: 5, expectedDelay: MAX_DELAY_MS, expectedCount: 6 }, // capped at 300s
            { prior: 8, expectedDelay: MAX_DELAY_MS, expectedCount: 9 }, // still capped
        ])(
            'deferredCount=$expectedCount → delayMs=$expectedDelay',
            async ({ prior, expectedDelay, expectedCount }) => {
                const job = makeJob({
                    metadata: {
                        byokConcurrencyGate: { deferredCount: prior },
                    },
                });

                const result = await service.tryEnter(job);

                expect(result.kind).toBe('deferred');
                if (result.kind !== 'deferred') return;
                expect(result.deferredCount).toBe(expectedCount);
                expect(result.delayMs).toBe(expectedDelay);
            },
        );

        it('force-acquires when deferred count exceeds MAX_DEFERRALS (10)', async () => {
            const lock: Lock = { release: jest.fn() };
            // First 3 slot attempts return null (the original loop is sized by maxConcurrentRequests=1 → only 1 attempt).
            // Then the force-acquire path acquires slot 0 with TTL.
            distributedLockService.acquire
                .mockResolvedValueOnce(null) // initial loop, slot 0 busy
                .mockResolvedValueOnce(lock); // force-acquire slot 0

            const job = makeJob({
                metadata: {
                    byokConcurrencyGate: { deferredCount: MAX_DEFERRALS },
                },
            });

            const result = await service.tryEnter(job);

            expect(result).toEqual({ kind: 'acquired', lock });
            expect(distributedLockService.acquire).toHaveBeenCalledTimes(2);
            // Force-acquire passes ttl
            expect(distributedLockService.acquire.mock.calls[1][1]).toEqual({
                ttl: 30_000,
            });
        });

        it('returns deferred at MAX_DELAY when force-acquire also fails', async () => {
            distributedLockService.acquire.mockResolvedValue(null);

            const job = makeJob({
                metadata: {
                    byokConcurrencyGate: { deferredCount: MAX_DEFERRALS },
                },
            });

            const result = await service.tryEnter(job);

            expect(result).toEqual({
                kind: 'deferred',
                delayMs: MAX_DELAY_MS,
                deferredCount: MAX_DEFERRALS + 1,
            });
        });
    });

    describe('tryEnter — scope key isolation', () => {
        it('uses a different lock key per organization', async () => {
            orgParamsService.findByKey.mockResolvedValue({
                configValue: { main: makeMainConfig({ maxConcurrentRequests: 1 }) },
            });
            distributedLockService.acquire.mockResolvedValue({
                release: jest.fn(),
            });

            await service.tryEnter(
                makeJob({
                    organizationAndTeamData: { organizationId: 'org-A' },
                }),
            );
            await service.tryEnter(
                makeJob({
                    organizationAndTeamData: { organizationId: 'org-B' },
                }),
            );

            const keyA = distributedLockService.acquire.mock.calls[0][0];
            const keyB = distributedLockService.acquire.mock.calls[1][0];
            expect(keyA).not.toBe(keyB);
            expect(keyA).toContain('org-A');
            expect(keyB).toContain('org-B');
        });

        it('uses the same lock key for the same provider+apiKey+model+org', async () => {
            orgParamsService.findByKey.mockResolvedValue({
                configValue: { main: makeMainConfig({ maxConcurrentRequests: 1 }) },
            });
            distributedLockService.acquire.mockResolvedValue({
                release: jest.fn(),
            });

            await service.tryEnter(makeJob());
            await service.tryEnter(makeJob({ id: 'job-2' }));

            const key1 = distributedLockService.acquire.mock.calls[0][0];
            const key2 = distributedLockService.acquire.mock.calls[1][0];
            expect(key1).toBe(key2);
        });
    });

    describe('deferJob', () => {
        it('updates the job to PENDING with byokConcurrencyGate metadata', async () => {
            const job = makeJob();

            await service.deferJob(job, { delayMs: 30_000, deferredCount: 2 });

            expect(jobRepository.update).toHaveBeenCalledTimes(1);
            const [jobId, update] = jobRepository.update.mock.calls[0];
            expect(jobId).toBe('job-1');
            expect(update.status).toBe(JobStatus.PENDING);
            expect(update.scheduledAt).toBeInstanceOf(Date);
            expect(update.metadata.byokConcurrencyGate.deferredCount).toBe(2);
            expect(update.metadata.byokConcurrencyGate.delayMs).toBe(30_000);
        });

        it('writes an outbox entry with future nextAttemptAt', async () => {
            const job = makeJob();
            const before = Date.now();

            await service.deferJob(job, { delayMs: 60_000, deferredCount: 3 });

            expect(outboxRepository.create).toHaveBeenCalledTimes(1);
            const arg = outboxRepository.create.mock.calls[0][0];
            expect(arg.jobId).toBe('job-1');
            expect(arg.exchange).toBe('workflow.exchange');
            expect(arg.routingKey).toBe(
                'workflow.jobs.deferred.code_review',
            );
            expect(arg.nextAttemptAt).toBeInstanceOf(Date);
            // Within ±1s of now+60s
            const expectedTs = before + 60_000;
            expect(
                Math.abs(arg.nextAttemptAt.getTime() - expectedTs),
            ).toBeLessThan(1_000);
        });

        it('preserves prior job metadata while adding byokConcurrencyGate field', async () => {
            const job = makeJob({
                metadata: { foo: 'bar', counter: 7 },
            });

            await service.deferJob(job, { delayMs: 15_000, deferredCount: 1 });

            const update = jobRepository.update.mock.calls[0][1];
            expect(update.metadata.foo).toBe('bar');
            expect(update.metadata.counter).toBe(7);
            expect(update.metadata.byokConcurrencyGate).toBeDefined();
        });
    });
});
