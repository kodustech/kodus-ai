import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { liveRunFor, reservationFor, withReservation } from '../application/llm-run-budget';
import { LlmBudgetBusyError } from '../domain/ports';
import { TypeOrmRuntimeLlmBudgetStore } from '../infrastructure/typeorm-llm-budget.store';
import type { RunTokenClaims } from '../domain/run-token';
import { InMemoryLlmUsage, NOW, ORG, OTHER_ORG, run, storeWith } from './fixtures';

const claimsFor = (r: { runId: string; attempt: number; organizationId: string; teamId: string; repositoryId: string; prNumber: number }): RunTokenClaims => ({
    runId: r.runId,
    attempt: r.attempt,
    organizationId: r.organizationId,
    teamId: r.teamId,
    repositoryId: r.repositoryId,
    prNumber: r.prNumber,
    exp: Math.floor(NOW.getTime() / 1000) + 600,
});

describe('liveRunFor', () => {
    it('answers the token\'s own running Run', async () => {
        const r = run({ state: 'testing' });
        await expect(liveRunFor(await storeWith(r), claimsFor(r), r.runId)).resolves.toMatchObject({ runId: r.runId });
    });

    it('refuses another Run, another org, another attempt and a finished Run, in that order', async () => {
        const r = run({ state: 'testing' });
        const store = await storeWith(r);
        await expect(liveRunFor(store, claimsFor(r), 'other-run')).rejects.toBeInstanceOf(ForbiddenException);
        // Another org's token never sees the Run: 404, not 403.
        await expect(liveRunFor(store, { ...claimsFor(r), organizationId: OTHER_ORG }, r.runId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(liveRunFor(store, { ...claimsFor(r), attempt: 2 }, r.runId)).rejects.toThrow('The run token is for another attempt');
        const done = run({ state: 'regression' });
        await expect(liveRunFor(await storeWith(done), claimsFor(done), done.runId)).rejects.toBeInstanceOf(ConflictException);
    });

    it('checks the extra token fields with the caller\'s message', async () => {
        const r = run({ state: 'testing' });
        const check = { mismatch: 'Run token scope mismatch', sameAs: ['teamId'] as const };
        await expect(liveRunFor(await storeWith(r), { ...claimsFor(r), teamId: 'team-b' }, r.runId, check)).rejects.toThrow('Run token scope mismatch');
    });
});

describe('withReservation', () => {
    const scope = { runId: 'run-1', organizationId: ORG, repositoryId: 'repo-1', prNumber: 7, task: 'runtime.plan' };

    it('a refused budget reserves nothing and never runs the call', async () => {
        const usage = new InMemoryLlmUsage();
        const call = jest.fn();
        await expect(withReservation(usage, reservationFor(scope, NOW, () => null), call, { onFailure: 'release' })).resolves.toEqual({ reserved: false });
        expect(call).not.toHaveBeenCalled();
        expect(usage.rows).toHaveLength(0);
    });

    it('a successful call leaves the reservation for the caller to settle', async () => {
        const usage = new InMemoryLlmUsage();
        const out = await withReservation(usage, reservationFor(scope, NOW, () => 100), async (r) => r.tokens * 2, { onFailure: 'release' });
        expect(out).toMatchObject({ reserved: true, value: 200, reservation: { tokens: 100 } });
        expect(usage.rows).toEqual([expect.objectContaining({ pending: true, inputTokens: 100, at: NOW })]);
    });

    it('release: a failed call gives the tokens back', async () => {
        const usage = new InMemoryLlmUsage();
        const failing = withReservation(usage, reservationFor(scope, NOW, () => 100), async () => Promise.reject(new Error('provider down')), { onFailure: 'release' });
        await expect(failing).rejects.toThrow('provider down');
        expect(usage.rows).toHaveLength(0);
    });

    it('count_reserved: a failed call keeps the whole reservation counted as spent, with its model', async () => {
        const usage = new InMemoryLlmUsage();
        const failing = withReservation(usage, reservationFor(scope, NOW, () => 100), async () => Promise.reject(new Error('timeout')), {
            onFailure: 'count_reserved',
            model: 'm-1',
        });
        await expect(failing).rejects.toThrow('timeout');
        expect(usage.rows).toEqual([expect.objectContaining({ pending: false, inputTokens: 100, outputTokens: 0, model: 'm-1' })]);
    });

    it('leave: a failed call owns its reservation', async () => {
        const usage = new InMemoryLlmUsage();
        const failing = withReservation(usage, reservationFor(scope, NOW, () => 100), async () => Promise.reject(new Error('x')), { onFailure: 'leave' });
        await expect(failing).rejects.toThrow('x');
        expect(usage.rows).toEqual([expect.objectContaining({ pending: true })]);
    });

    it('a busy budget lock is refused without a line of its own: the answer the caller makes is the one line', async () => {
        const sql = { transaction: async () => Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })) };
        const store = new TypeOrmRuntimeLlmBudgetStore(sql as any, 50);
        const warn = jest.spyOn((store as any).logger, 'warn').mockImplementation(() => undefined);
        await expect(store.reserve(reservationFor(scope, NOW, () => 1))).rejects.toBeInstanceOf(LlmBudgetBusyError);
        expect(warn).not.toHaveBeenCalled();
    });

    it('a busy budget lock answers 503 only when asked', async () => {
        const busy = { reserve: async () => Promise.reject(new LlmBudgetBusyError()), settle: jest.fn(), cancel: jest.fn() };
        await expect(withReservation(busy, reservationFor(scope, NOW, () => 1), jest.fn(), { onFailure: 'release', busyAsUnavailable: true })).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        await expect(withReservation(busy, reservationFor(scope, NOW, () => 1), jest.fn(), { onFailure: 'release' })).rejects.toBeInstanceOf(LlmBudgetBusyError);
    });
});
