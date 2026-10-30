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
            { prior: 2, expectedDelay: 4 * BASE_DELAY_MS, expectedCount: 3 }, // 60s
            { prior: 5, expectedDelay: MAX_DELAY_MS, expectedCount: 6 }, // capped at 300s
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

        // A non-number would otherwise be string-concatenated ('5' + 1).
        it('treats a non-numeric or missing stored count as a first deferral', async () => {
            for (const metadata of [
                { byokConcurrencyGate: { deferredCount: '5' } },
                null,
            ]) {
                const result = await service.tryEnter(makeJob({ metadata }));
                expect(result).toEqual({
                    kind: 'deferred',
                    deferredCount: 1,
                    delayMs: BASE_DELAY_MS,
                });
            }
        });

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

        // This used to assert another deferral, which is what made
        // MAX_DEFERRALS a label instead of a limit. The force-acquire targets
        // `slot:0`, so when that slot is the leaked one the branch can never
        // succeed and the job returns to it forever. Production reached
        // deferredCount 452 against a cap of 10, across 315 jobs and 4
        // organizations, whose reviews never ran and who were never told.
        it('gives up instead of deferring again when force-acquire also fails', async () => {
            distributedLockService.acquire.mockResolvedValue(null);

            const job = makeJob({
                metadata: {
                    byokConcurrencyGate: { deferredCount: MAX_DEFERRALS },
                },
            });

            const result = await service.tryEnter(job);

            expect(result).toEqual({
                kind: 'exhausted',
                deferredCount: MAX_DEFERRALS + 1,
            });
        });

        // The cap has to hold however far past it the counter already is --
        // a job that came back at 451 must not get a 452nd deferral.
        it('stays terminal for a job already far past the cap', async () => {
            distributedLockService.acquire.mockResolvedValue(null);

            const job = makeJob({
                metadata: {
                    byokConcurrencyGate: { deferredCount: 451 },
                },
            });

            const result = await service.tryEnter(job);

            expect(result).toEqual({ kind: 'exhausted', deferredCount: 452 });
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

    it('scopes the lock by API key, not just by organization', () => {
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
    });

    describe('deferJob', () => {
        it('marks the job PENDING with the gate metadata, keeping prior metadata', async () => {
            const job = makeJob({ metadata: { foo: 'bar', counter: 7 } });

            await service.deferJob(job, { delayMs: 30_000, deferredCount: 2 });

            expect(jobRepository.update).toHaveBeenCalledTimes(1);
            const [jobId, update] = jobRepository.update.mock.calls[0];
            expect(jobId).toBe('job-1');
            expect(update.status).toBe(JobStatus.PENDING);
            expect(update.metadata.foo).toBe('bar');
            expect(update.metadata.counter).toBe(7);
            const gate = update.metadata.byokConcurrencyGate;
            expect(gate.deferredCount).toBe(2);
            expect(gate.delayMs).toBe(30_000);
            expect(gate.nextAttemptAt).toBe(update.scheduledAt.toISOString());
        });

        it('writes an outbox entry due after the delay, on the same instant as the job', async () => {
            const job = makeJob({
                organizationAndTeamData: {
                    organizationId: 'org-77',
                    teamId: 'team-99',
                },
            });
            const before = Date.now();

            await service.deferJob(job, { delayMs: 60_000, deferredCount: 3 });

            expect(outboxRepository.create).toHaveBeenCalledTimes(1);
            const outboxArg = outboxRepository.create.mock.calls[0][0];
            const jobUpdate = jobRepository.update.mock.calls[0][1];

            expect(outboxArg.jobId).toBe('job-1');
            expect(outboxArg.exchange).toBe('workflow.exchange');
            expect(
                messageBroker.transformMessageToMessageBroker,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ eventName: 'workflow.jobs.deferred' }),
            );
            expect(outboxArg.routingKey).toBe(
                'workflow.jobs.deferred.code_review',
            );
            expect(outboxArg.payload).toEqual({
                jobId: 'job-1',
                correlationId: 'corr-1',
                workflowType: 'code_review',
                handlerType: 'agent_review',
                organizationId: 'org-77',
                teamId: 'team-99',
            });
            expect(
                Math.abs(outboxArg.nextAttemptAt.getTime() - (before + 60_000)),
            ).toBeLessThan(1_000);
            expect(outboxArg.nextAttemptAt.getTime()).toBe(
                jobUpdate.scheduledAt.getTime(),
            );
        });
    });
});
