import { CellUnavailableError, MemberCleanupPendingError } from '../../shared/errors';
import { DBOS, DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';

import type { RuntimeRunRequested } from '@libs/runtime/run';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryAdmissionStore } from '../../shared/admission/admission-store';
import type { AdmissionRef, PhysicalAdmissionClient, PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import { InMemoryDistributedLocks } from '../../shared/persistence/locks';
import { InMemoryCommandStore } from '../../shared/persistence/pg-command-store';
import { AdmissionCoordinator } from './admission-coordinator';
import { RunEngineService } from './run-engine.service';
import { inMemoryRunDeps } from '../run/in-memory-deps';

const LIMITS = { globalWaiting: 100, perOrgWaiting: 10, globalExecuting: 2, perOrgExecuting: 2, maxAttempts: 360, leaseMs: 30_000, retryMs: 5_000, attemptConcurrency: 4, attemptPerOrg: 1 };

describe('native DBOS workflow identity during admission', () => {
    afterEach(() => jest.restoreAllMocks());

    async function build(withSetup = false) {
        const clock = new Date();
        const rows = new Map<string, any>();
        const workflows = new Map<string, (...args: any[]) => Promise<unknown>>();
        jest.spyOn(DBOS, 'registerWorkflow').mockImplementation((fn, options) => { workflows.set(options!.name!, fn as any); return fn as any; });
        jest.spyOn(DBOS, 'setConfig').mockImplementation(() => undefined);
        jest.spyOn(DBOS, 'launch').mockResolvedValue(undefined);
        const queues = jest.spyOn(DBOS, 'registerQueue').mockResolvedValue(undefined);
        jest.spyOn(DBOS, 'runStep').mockImplementation(async (fn) => fn());
        const start = jest.spyOn(DBOS, 'startWorkflow').mockImplementation(((fn: any, options: any) => async (...args: any[]) => {
            if (!rows.has(options.workflowID)) rows.set(options.workflowID, { workflowID: options.workflowID, status: options.enqueueOptions?.delaySeconds ? 'DELAYED' : 'ENQUEUED', queueName: options.queueName, input: args, fn });
            return { workflowID: options.workflowID, getResult: async () => undefined };
        }) as any);
        jest.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async (id) => rows.get(id) ?? null);
        jest.spyOn(DBOS, 'cancelWorkflow').mockImplementation(async (id) => { const row = rows.get(id); if (row) row.status = 'CANCELLED'; });
        const wake = jest.spyOn(DBOS, 'setWorkflowDelay').mockImplementation(async (id, seconds) => {
            expect(typeof seconds === 'number' && seconds > 0).toBe(true);
            const row = rows.get(id);
            if (row?.status === 'DELAYED') row.status = 'ENQUEUED';
        });
        const store = new InMemoryAdmissionStore({ now: () => clock });
        const physical: PhysicalAdmissionClient = {
            reserve: jest.fn(async () => ({ status: 'refused' as const, reason: 'no_capacity' as const, retryable: true })),
            redeem: jest.fn(async () => true), cancel: jest.fn(async () => undefined),
        };
        const settings = { ...LIMITS };
        const coordinator = new AdmissionCoordinator(store, physical, settings, () => clock);
        const memory = inMemoryRunDeps();
        const projection = memory.projection;
        const factory = { forRun: jest.fn((_req: RuntimeRunRequested, _ticket?: PhysicalAdmissionTicket) => memory.deps), forStop: jest.fn(() => memory.deps), reap: async () => 0 };
        const engine = new (RunEngineService as any)(
            { durableAdmission: true, admission: settings, globalConcurrency: 2, partitionConcurrency: 2, releaseVersion: 'admission-test', sweeper: false },
            factory, projection,
            new RuntimeMetrics(), new InMemoryCommandStore(), new InMemoryDistributedLocks(), withSetup ? { run: jest.fn() } : undefined, undefined, coordinator,
        ) as RunEngineService;
        await engine.onModuleInit();
        const req = shopRunRequest({ requestedAt: clock.toISOString() });
        await projection.upsert(req.runId, { organizationId: req.organizationId, attempt: req.attempt, state: 'queued', requestedAt: req.requestedAt });
        return { engine, req, store, physical, coordinator, rows, workflows, queues, start, wake, clock, factory, projection };
    }

    it('creates the original execution DELAYED and a separate short admission attempt', async () => {
        const h = await build();

        expect(await h.engine.start(h.req)).toBe(h.req.runId);

        expect(h.rows.get(h.req.runId)).toMatchObject({ status: 'DELAYED', queueName: 'runtime-executions' });
        expect([...h.rows.values()].filter((row) => row.queueName === 'runtime-admissions')).toHaveLength(1);
        expect(h.queues).toHaveBeenCalledWith('runtime-executions', expect.objectContaining({ concurrency: 2, partitionConcurrency: 2 }));
    });

    it('a refused attempt schedules another delayed attempt without waking native execution', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const attempt = [...h.rows.values()].find((row) => row.queueName === 'runtime-admissions');

        await attempt.fn(...attempt.input);

        expect(h.rows.get(h.req.runId).status).toBe('DELAYED');
        expect([...h.rows.values()].filter((row) => row.queueName === 'runtime-admissions')).toHaveLength(2);
        expect(h.wake).not.toHaveBeenCalled();
    });

    it('records cancellation before cancelling the original delayed execution', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const ref: AdmissionRef = { organizationId: h.req.organizationId, kind: 'run', key: h.req.runId };
        const cancel = jest.spyOn(DBOS, 'cancelWorkflow').mockImplementation(async (id) => {
            expect((await h.store.get(ref))?.state).toBe('cancelled');
            const row = h.rows.get(id); if (row) row.status = 'CANCELLED';
        });

        await h.engine.stop({ ...h.req, headSha: h.req.pullRequest.headSha }, 'cancelled', 'closed');

        expect(cancel).toHaveBeenCalledWith(h.req.runId);
        expect(h.rows.get(h.req.runId).status).toBe('CANCELLED');
    });

    async function reservedRun(h: Awaited<ReturnType<typeof build>>) {
        h.physical.reserve = jest.fn(async (request) => ({ status: 'reserved' as const, ticket: {
            organizationId: request.organizationId, kind: request.kind, key: request.key, generation: request.generation,
            ticketOwnerToken: request.ticketOwnerToken, ticketId: 'cleanup-ticket', cellId: 'cell', sessionEpoch: 'epoch',
            expiresAt: new Date(h.clock.getTime() + 120_000).toISOString(), members: [],
        } }));
        await h.engine.start(h.req);
        const attempt = [...h.rows.values()].find(row => row.queueName === 'runtime-admissions');
        await attempt.fn(...attempt.input);
        return { organizationId: h.req.organizationId, kind: 'run' as const, key: h.req.runId };
    }

    it('does not warn on a pending finish checkpoint; the normal reconciler completes cleanup without replaying execution', async () => {
        const h = await build();
        const ref = await reservedRun(h);
        const cancel = jest.spyOn(h.physical, 'cancel').mockRejectedValue(new MemberCleanupPendingError());
        const warn = jest.spyOn((h.engine as any).logger, 'warn');
        const original = h.rows.get(h.req.runId);
        expect(await original.fn(...original.input)).toMatchObject({ state: 'regression' });
        original.status = 'SUCCESS';
        expect(await h.store.get(ref)).toMatchObject({ state: 'running', permitHeld: true, ticket: { ticketId: 'cleanup-ticket' } });
        expect(warn).not.toHaveBeenCalled();
        cancel.mockResolvedValue(undefined);
        await h.engine.repairAdmission(h.clock);
        expect(await h.store.get(ref)).toMatchObject({ state: 'completed', permitHeld: false, ticket: null });
        expect(h.factory.forRun).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        [new MemberCleanupPendingError(), undefined],
        [new CellUnavailableError('secret-response-body'), 'cell_unavailable'],
        [new Error('secret-response-body'), 'unexpected'],
    ])('stop preserves cleanup intent and logs only actual failures as a closed category: %s', async (error, reason) => {
        const h = await build();
        const ref = await reservedRun(h);
        jest.spyOn(h.physical, 'cancel').mockRejectedValue(error);
        const warn = jest.spyOn((h.engine as any).logger, 'warn');
        await h.engine.stop({ ...h.req, headSha: h.req.pullRequest.headSha }, 'cancelled', 'closed');
        expect(await h.store.get(ref)).toMatchObject({ state: 'cancelled', permitHeld: true, ticket: { ticketId: 'cleanup-ticket' } });
        expect(h.rows.get(h.req.runId).status).toBe('CANCELLED');
        if (reason) expect(warn).toHaveBeenCalledWith({ msg: 'admission.ticket_cleanup_failed', organizationId: h.req.organizationId, key: h.req.runId, reason });
        else expect(warn).not.toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-response-body');
    });

    it('delayed native execution reaches a timed-out result without planning when admission never succeeds', async () => {
        const h = await build();
        await h.engine.start(h.req);
        h.clock.setTime(h.clock.getTime() + 30 * 60_000 + 1);
        const original = h.rows.get(h.req.runId);

        expect(await original.fn(...original.input)).toMatchObject({ state: 'timed_out' });

        expect(h.factory.forRun).not.toHaveBeenCalled();
        expect((await h.projection.get(h.req.runId))?.state).toBe('timed_out');
        expect(h.physical.redeem).not.toHaveBeenCalled();
    });

    it('repairs an attempt that failed before take progressed under a bounded new attempt ID', async () => {
        const h = await build();
        h.physical.reserve = jest.fn(async (request) => ({ status: 'reserved' as const, ticket: {
            organizationId: request.organizationId, kind: request.kind, key: request.key, generation: request.generation,
            ticketOwnerToken: request.ticketOwnerToken, ticketId: 'ticket-1', cellId: 'cell-1', sessionEpoch: 'session-1',
            expiresAt: new Date(h.clock.getTime() + 120_000).toISOString(), members: [],
        } }));
        await h.engine.start(h.req);
        const failed = [...h.rows.values()].find((row) => row.queueName === 'runtime-admissions');
        failed.status = 'ERROR';

        await h.engine.repairAdmission(h.clock);
        const repaired = [...h.rows.values()].find((row) => row.queueName === 'runtime-admissions' && row.workflowID !== failed.workflowID);

        expect(repaired.workflowID).toMatch(/:repair:\d+$/);
        await repaired.fn(...repaired.input);
        expect(h.rows.get(h.req.runId).status).toBe('ENQUEUED');
        const original = h.rows.get(h.req.runId);
        expect(await original.fn(...original.input)).toMatchObject({ state: 'regression' });
        expect(h.factory.forRun).toHaveBeenCalledTimes(1);
        expect(h.factory.forRun.mock.calls[0][1]).toMatchObject({ ticketId: 'ticket-1' });
        await h.engine.repairAdmission(h.clock);
        expect(h.factory.forRun).toHaveBeenCalledTimes(1);
    });

    it('a cancelled delayed attempt cannot resurrect work on redelivery', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const attempt = [...h.rows.values()].find((row) => row.queueName === 'runtime-admissions');
        await h.engine.stop({ ...h.req, headSha: h.req.pullRequest.headSha }, 'cancelled', 'closed');

        await attempt.fn(...attempt.input);
        await h.engine.start(h.req);

        expect(h.rows.get(h.req.runId).status).toBe('CANCELLED');
        expect(h.physical.reserve).not.toHaveBeenCalled();
        expect([...h.rows.values()].filter((row) => row.queueName === 'runtime-admissions')).toHaveLength(1);
    });

    it('bounds new rejected setup finalization instead of starting it outside every queue', async () => {
        const h = await build(true);
        h.coordinator.limits.globalWaiting = 1;
        await h.engine.start(h.req);

        const id = await h.engine.startSetup({ environmentId: 'env-rejected', organizationId: 'org-other', teamId: 'team', repositoryId: 'repo', repositoryName: 'shop',
            key: 'setup-rejected', requestedAt: h.clock.toISOString(), requestedBy: { userId: 'user' } });

        expect(h.rows.get(id as string)).toMatchObject({ queueName: 'runtime-admission-finalizers' });
    });

    it('conflicting Run input cannot finalize an already accepted canonical execution', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const count = h.rows.size;

        expect(await h.engine.start({ ...h.req, pullRequest: { ...h.req.pullRequest, title: 'different redelivery' } })).toBe(h.req.runId);

        expect(h.rows.size).toBe(count);
        expect(h.rows.has(`${h.req.runId}:stop`)).toBe(false);
        expect((await h.coordinator.store.get({ organizationId: h.req.organizationId, kind: 'run', key: h.req.runId }))?.state).toBe('waiting');
    });

    it('conflicting setup input cannot replace the accepted environment with a rejection result', async () => {
        const h = await build(true);
        const cmd = { environmentId: 'env-setup', organizationId: 'org-other', teamId: 'team', repositoryId: 'repo', repositoryName: 'shop',
            key: 'setup-existing', requestedAt: h.clock.toISOString(), requestedBy: { userId: 'user' } };
        const original = await h.engine.startSetup(cmd);
        const count = h.rows.size;

        expect(await h.engine.startSetup({ ...cmd, repositoryName: 'different redelivery' })).toBe(original);

        expect(h.rows.size).toBe(count);
        expect(h.rows.has(`${original}:admission-rejected`)).toBe(false);
    });

    it('rejected Run finalizers retain only stopped-run identity rather than the rejected payload', async () => {
        const h = await build();
        h.coordinator.limits.maxPayloadBytes = 1;

        await h.engine.start(h.req);

        const queued = h.rows.get(`${h.req.runId}:stop`);
        expect(queued.input[0]).toEqual({ runId: h.req.runId, organizationId: h.req.organizationId,
            attempt: h.req.attempt, correlationId: h.req.correlationId, headSha: h.req.pullRequest.headSha });
        expect(JSON.stringify(queued.input)).not.toContain('repoToken');
        expect(JSON.stringify(queued.input)).not.toContain('diff');
    });

    it('a stale SDK execution cannot release the stable physical ticket while the current owner continues', async () => {
        const h = await build();
        h.physical.reserve = jest.fn(async (request) => ({ status: 'reserved' as const, ticket: {
            ...request, ticketId: 'owner-ticket', cellId: 'cell-1', sessionEpoch: 'session-1',
            expiresAt: new Date(h.clock.getTime() + 120_000).toISOString(), members: [],
        } }));
        await h.engine.start(h.req);
        const attempt = [...h.rows.values()].find((row) => row.queueName === 'runtime-admissions');
        await attempt.fn(...attempt.input);
        const conflict = new DBOSWorkflowConflictError(h.req.runId);
        const dependencies = h.factory.forRun(h.req);
        jest.mocked(DBOS.runStep).mockImplementation(async (callback, options) => {
            // Ownership can be lost after both claims boot, at a public SDK step boundary.
            if (options?.name === 'agent:plan') return (async () => { throw conflict; })();
            return callback();
        });
        const release = jest.spyOn(dependencies.env, 'release');
        const plan = jest.spyOn(dependencies.agent, 'plan');
        const execution = h.rows.get(h.req.runId);

        await expect(execution.fn(...execution.input)).rejects.toBe(conflict);

        expect(h.physical.cancel).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(plan).not.toHaveBeenCalled();
        expect((await h.projection.get(h.req.runId))?.state).toBe('testing');
        expect((await h.store.get({ organizationId: h.req.organizationId, kind: 'run', key: h.req.runId }))?.permitHeld).toBe(true);
    });

    it('finishes one slow maintenance item and then leaves the next item for a later bounded scan', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const second = shopRunRequest({ requestedAt: h.clock.toISOString() });
        await h.engine.start(second);
        const refs = [h.req, second].map((request) => ({ organizationId: request.organizationId, kind: 'run' as const, key: request.runId, generation: 0, action: 'finalize' as const }));
        jest.spyOn(h.store, 'due').mockResolvedValue(refs);
        h.rows.get(h.req.runId).status = 'ERROR';
        const read = jest.spyOn(h.store, 'get');
        let elapsed = 0;
        jest.spyOn(Date, 'now').mockImplementation(() => elapsed);
        jest.spyOn(h.coordinator, 'finish').mockImplementation(async () => {
            elapsed = 6_000;
            return { finished: true, cleanupFailed: false };
        });

        await h.engine.repairAdmission(h.clock);

        expect(read).toHaveBeenCalledTimes(1);
        expect(h.coordinator.finish).toHaveBeenCalledTimes(1);
    });

    it('does not recreate a completed original workflow after native DBOS retention removed it', async () => {
        const h = await build();
        await h.engine.start(h.req);
        const ref: AdmissionRef = { organizationId: h.req.organizationId, kind: 'run', key: h.req.runId };
        const stored = (await h.store.get(ref))!;
        jest.spyOn(h.store, 'due').mockResolvedValue([{ ...ref, generation: stored.generation, action: 'finalize' }]);
        jest.spyOn(h.store, 'get').mockResolvedValue({ ...stored, state: 'completed' });
        h.rows.delete(h.req.runId);
        const starts = h.start.mock.calls.length;

        await h.engine.repairAdmission(h.clock);

        expect(h.rows.has(h.req.runId)).toBe(false);
        expect(h.start.mock.calls.length).toBe(starts);
    });
});
