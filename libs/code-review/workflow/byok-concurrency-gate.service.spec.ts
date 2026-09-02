// The gate resolves the codeReview slot through StaticTaskStrategy, whose
// capability gate consults the provider REGISTRY. Mock it capable so any v2
// model routes (the gate's own logic — not routing — is under test here).
jest.mock('@libs/llm/providers', () => ({
    REGISTRY: {
        has: (_p: string) => true,
        get: (_p: string) => ({
            capabilities: (_model: string) => ({
                structuredOutput: 'json_schema',
                toolCalling: 'native',
            }),
        }),
    },
}));

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

// A v2 BYOK blob that routes `codeReview` to a single anthropic model carrying
// the given maxConcurrentRequests. This is the stored shape the gate now reads
// (native — no legacy {main,fallback}).
const makeV2Config = (
    overrides: { maxConcurrentRequests?: number } = {},
): any => ({
    version: 2,
    credentials: [{ id: 'c1', provider: 'anthropic', apiKey: 'sk-test' }],
    models: [
        {
            id: 'm1',
            credentialId: 'c1',
            model: 'claude-sonnet-4-5',
            maxConcurrentRequests: overrides.maxConcurrentRequests ?? 3,
        },
    ],
    routing: { defaultModelId: 'm1' },
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
                configValue: makeV2Config({ maxConcurrentRequests: 0 }),
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
                configValue: makeV2Config({ maxConcurrentRequests: 3 }),
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
                configValue: makeV2Config({ maxConcurrentRequests: 1 }),
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
                configValue: makeV2Config({ maxConcurrentRequests: 1 }),
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
                configValue: makeV2Config({ maxConcurrentRequests: 1 }),
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

    // Direct unit coverage of the deterministic private methods. These target
    // the exact literals, field order, separators, boundaries and defaults so a
    // plausible regression (wrong separator, flipped order, off-by-one exponent,
    // dropped Math.max guard, wrong default) makes a test fail.
    describe('buildScopeKey (deterministic)', () => {
        it('joins all six segments with :: in exact order, including the 16-char sha256 fingerprint', () => {
            const key = (service as any).buildScopeKey(
                makeJob({
                    organizationAndTeamData: { organizationId: 'org-1' },
                }),
                {
                    provider: 'openai',
                    apiKey: 'secret-key',
                    baseURL: 'https://api.example.com',
                    model: 'gpt-4',
                },
            );

            // Fingerprint = sha256('openai::secret-key::https://api.example.com').slice(0,16)
            expect(key).toBe(
                'byok-concurrency::org-1::openai::35fa84d497f8c00c::https://api.example.com::gpt-4',
            );
        });

        it('falls back to "global" org and "" for empty baseURL/model', () => {
            const key = (service as any).buildScopeKey(
                makeJob({ organizationAndTeamData: undefined }),
                {
                    provider: 'anthropic',
                    apiKey: 'key-2',
                    // baseURL + model intentionally omitted -> both default to ''
                },
            );

            // Fingerprint = sha256('anthropic::key-2::').slice(0,16)
            expect(key).toBe(
                'byok-concurrency::global::anthropic::c3c77621a8c19cb3::::',
            );
        });

        it('produces a 16-hex-char fingerprint segment (slice 0,16)', () => {
            const key = (service as any).buildScopeKey(makeJob(), {
                provider: 'openai',
                apiKey: 'secret-key',
                baseURL: 'https://api.example.com',
                model: 'gpt-4',
            });
            const fingerprint = key.split('::')[3];
            expect(fingerprint).toBe('35fa84d497f8c00c');
            expect(fingerprint).toHaveLength(16);
            expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
        });

        it('changes the fingerprint when apiKey changes (apiKey is hashed in)', () => {
            const base = {
                provider: 'openai',
                apiKey: 'secret-key',
                baseURL: 'https://api.example.com',
                model: 'gpt-4',
            };
            const key1 = (service as any).buildScopeKey(makeJob(), base);
            const key2 = (service as any).buildScopeKey(makeJob(), {
                ...base,
                apiKey: 'different-key',
            });
            expect(key1).not.toBe(key2);
            expect(key1.split('::')[3]).not.toBe(key2.split('::')[3]);
        });
    });

    describe('getDeferredCount (deterministic)', () => {
        it('returns the numeric deferredCount from metadata', () => {
            const job = makeJob({
                metadata: { byokConcurrencyGate: { deferredCount: 5 } },
            });
            expect((service as any).getDeferredCount(job)).toBe(5);
        });

        it('returns 0 (not the value) when deferredCount is stored as 0', () => {
            const job = makeJob({
                metadata: { byokConcurrencyGate: { deferredCount: 0 } },
            });
            expect((service as any).getDeferredCount(job)).toBe(0);
        });

        it('returns 0 when deferredCount is not a number (type guard)', () => {
            const job = makeJob({
                metadata: { byokConcurrencyGate: { deferredCount: '5' } },
            });
            expect((service as any).getDeferredCount(job)).toBe(0);
        });

        it('returns 0 when byokConcurrencyGate is absent', () => {
            const job = makeJob({ metadata: { other: true } });
            expect((service as any).getDeferredCount(job)).toBe(0);
        });

        it('returns 0 when metadata is null', () => {
            const job = makeJob({ metadata: null });
            expect((service as any).getDeferredCount(job)).toBe(0);
        });
    });

    describe('calculateDelayMs (deterministic)', () => {
        it.each([
            [0, BASE_DELAY_MS], // Math.max(0, -1) guard -> 2^0 = 1 -> 15000
            [1, BASE_DELAY_MS], // 2^0 = 1 -> 15000
            [2, 2 * BASE_DELAY_MS], // 2^1 = 2 -> 30000
            [3, 4 * BASE_DELAY_MS], // 2^2 = 4 -> 60000
            [5, 16 * BASE_DELAY_MS], // 2^4 = 16 -> 240000 (last below cap)
            [6, MAX_DELAY_MS], // 2^5 = 32 -> 480000 -> capped to 300000
            [50, MAX_DELAY_MS], // far above cap -> capped
        ])('deferredCount=%i -> %i ms', (count, expected) => {
            expect((service as any).calculateDelayMs(count)).toBe(expected);
        });

        it('never returns below BASE_DELAY_MS for the guarded low end', () => {
            expect((service as any).calculateDelayMs(0)).toBe(15_000);
            expect((service as any).calculateDelayMs(1)).toBe(15_000);
        });

        it('caps exactly at MAX_DELAY_MS (cap boundary between 5 and 6)', () => {
            expect((service as any).calculateDelayMs(5)).toBe(240_000);
            expect((service as any).calculateDelayMs(6)).toBe(300_000);
        });
    });

    describe('deferJob (deterministic side effects)', () => {
        it('sets exact lastError text and PENDING status with ISO metadata timestamps', async () => {
            const job = makeJob();
            await service.deferJob(job, { delayMs: 30_000, deferredCount: 2 });

            const update = jobRepository.update.mock.calls[0][1];
            expect(update.status).toBe(JobStatus.PENDING);
            expect(update.lastError).toBe(
                'Waiting for a BYOK concurrency slot before starting agent review',
            );
            const gate = update.metadata.byokConcurrencyGate;
            expect(gate.deferredCount).toBe(2);
            expect(gate.delayMs).toBe(30_000);
            // deferredAt/nextAttemptAt are ISO-8601 strings
            expect(gate.deferredAt).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            );
            expect(gate.nextAttemptAt).toBe(update.scheduledAt.toISOString());
        });

        it('builds the outbox payload by extracting org/team from organizationAndTeamData', async () => {
            const job = makeJob({
                organizationAndTeamData: {
                    organizationId: 'org-77',
                    teamId: 'team-99',
                },
            });

            await service.deferJob(job, { delayMs: 15_000, deferredCount: 1 });

            expect(
                messageBroker.transformMessageToMessageBroker,
            ).toHaveBeenCalledTimes(1);
            const brokerArg =
                messageBroker.transformMessageToMessageBroker.mock.calls[0][0];
            expect(brokerArg.eventName).toBe('workflow.jobs.deferred');
            expect(brokerArg.message).toEqual({
                jobId: 'job-1',
                correlationId: 'corr-1',
                workflowType: 'code_review',
                handlerType: 'agent_review',
                organizationId: 'org-77',
                teamId: 'team-99',
            });
        });

        it('uses the transformed broker output as the outbox payload and the same nextAttemptAt on both writes', async () => {
            const job = makeJob();
            await service.deferJob(job, { delayMs: 45_000, deferredCount: 4 });

            const outboxArg = outboxRepository.create.mock.calls[0][0];
            const jobUpdate = jobRepository.update.mock.calls[0][1];

            expect(outboxArg.exchange).toBe('workflow.exchange');
            expect(outboxArg.routingKey).toBe(
                'workflow.jobs.deferred.code_review',
            );
            // payload is exactly what the broker returned (the message here)
            expect(outboxArg.payload).toEqual({
                jobId: 'job-1',
                correlationId: 'corr-1',
                workflowType: 'code_review',
                handlerType: 'agent_review',
                organizationId: 'org-1',
                teamId: 'team-1',
            });
            // both the job.scheduledAt and outbox.nextAttemptAt are the same instant
            expect(outboxArg.nextAttemptAt.getTime()).toBe(
                jobUpdate.scheduledAt.getTime(),
            );
        });

        it('tolerates missing organizationAndTeamData (undefined org/team)', async () => {
            const job = makeJob({ organizationAndTeamData: undefined });
            await service.deferJob(job, { delayMs: 15_000, deferredCount: 1 });

            const brokerArg =
                messageBroker.transformMessageToMessageBroker.mock.calls[0][0];
            expect(brokerArg.message.organizationId).toBeUndefined();
            expect(brokerArg.message.teamId).toBeUndefined();
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
            expect(arg.routingKey).toBe('workflow.jobs.deferred.code_review');
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
