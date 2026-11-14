import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import type { EnvironmentSetupRecord, RuntimeRunRequested } from '@libs/runtime/run';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { shopRunRequest } from '../../e2e/fixtures';
import { ADMISSION_WAIT_MS, type AdmissionRef, type PhysicalAdmissionClient } from '../../shared/admission/admission-contract';
import { PgAdmissionStore } from '../../shared/admission/pg-admission-store';
import { InMemoryDistributedLocks } from '../../shared/persistence/locks';
import { InMemoryCommandStore } from '../../shared/persistence/pg-command-store';
import { ensureDatabase, ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { inMemoryRunDeps } from '../run/in-memory-deps';
import { AdmissionCoordinator } from './admission-coordinator';
import { ADMISSION_QUEUE, EXECUTION_QUEUE, RunEngineService, admissionAttemptWorkflowId, approvedRunWorkflowId, setupWorkflowId } from './run-engine.service';

// Real PostgreSQL + public DBOS scheduling, with fake physical admission and recorded in-memory Run work.
// This creates no containers, PRs, provider requests or live workloads.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
        if (Date.now() >= deadline) throw new Error('admission integration condition timed out');
        await pause(25);
    }
}

(skip ? describe.skip : describe)('durable admission scheduling (real PostgreSQL)', () => {
    const pool = new Pool({ connectionString: url });
    const store = new PgAdmissionStore(pool);
    const memory = inMemoryRunDeps();
    const limits = { globalWaiting: 100, perOrgWaiting: 20, globalExecuting: 2, perOrgExecuting: 2, maxAttempts: 360, leaseMs: 2_000, retryMs: 100, attemptConcurrency: 4, attemptPerOrg: 1 };
    const physical: PhysicalAdmissionClient = {
        reserve: async (request) => request.organizationId.startsWith('wait-')
            ? { status: 'refused', reason: 'no_capacity', retryable: true }
            : { status: 'reserved', ticket: { organizationId: request.organizationId, kind: request.kind, key: request.key, generation: request.generation,
                ticketOwnerToken: request.ticketOwnerToken, ticketId: `ticket-${request.key}`, cellId: 'fake-cell', sessionEpoch: 'fake-session',
                expiresAt: new Date(Date.now() + 120_000).toISOString(), members: [] } },
        redeem: async () => true,
        cancel: async () => undefined,
    };
    const coordinator = new AdmissionCoordinator(store, physical, limits);
    let releaseSetup: (() => void) | undefined;
    let setupActive = false;
    const setup = { run: async (cmd: RuntimeEnvironmentSetupRequested, step: any) => step('integration:setup', async () => {
        setupActive = true;
        await new Promise<void>((resolve) => { releaseSetup = resolve; });
        setupActive = false;
        return { environmentId: cmd.environmentId, state: 'active' } as EnvironmentSetupRecord;
    }) };
    const forRun = jest.fn((_req: RuntimeRunRequested) => {
        expect(setupActive).toBe(false);
        return memory.deps;
    });
    const engine = new RunEngineService(
        { databaseUrl: url, durableAdmission: true, admission: limits, globalConcurrency: 2, partitionConcurrency: 2,
            dbosLogLevel: 'error', sweeper: false, releaseVersion: `admission-it-${Date.now()}` } as any,
        { forRun, forStop: () => memory.deps, reap: async () => 0 }, memory.projection,
        new RuntimeMetrics(), new InMemoryCommandStore(), new InMemoryDistributedLocks(), setup as any, undefined, coordinator,
    );
    const accepted: RuntimeRunRequested[] = [];
    async function request(org: string, requestedAt = new Date().toISOString(), overrides: Partial<RuntimeRunRequested> = {}) {
        const req = shopRunRequest({ ...overrides, organizationId: org, requestedAt });
        accepted.push(req);
        await memory.projection.upsert(req.runId, { organizationId: req.organizationId, attempt: req.attempt, correlationId: req.correlationId,
            state: 'queued', requestedAt, headSha: req.pullRequest.headSha });
        await engine.start(req);
        return req;
    }

    beforeAll(async () => {
        await ensureDatabase(url);
        await ensureRuntimeSchema(pool);
        await engine.onModuleInit();
        await (await DBOS.retrieveQueue(ADMISSION_QUEUE))!.setMinPollingIntervalMs(20);
        await (await DBOS.retrieveQueue(EXECUTION_QUEUE))!.setMinPollingIntervalMs(20);
    }, 60_000);
    afterAll(async () => {
        releaseSetup?.();
        for (const req of accepted) {
            const workflow = await DBOS.getWorkflowStatus(req.runId);
            if (workflow && !['SUCCESS', 'ERROR', 'CANCELLED'].includes(workflow.status)) await engine.stop({ ...req, headSha: req.pullRequest.headSha }, 'cancelled', 'integration cleanup');
        }
        await engine.repairAdmission();
        await DBOS.shutdown({ deregister: true });
        await pool.end();
    }, 60_000);

    it('org B progresses while org A stays durably delayed for capacity', async () => {
        const suffix = Date.now();
        const waiting = await request(`wait-${suffix}`);
        const ref: AdmissionRef = { organizationId: waiting.organizationId, kind: 'run', key: waiting.runId };
        await until(async () => (await store.get(ref))!.generation > 0);
        const ready = await request(`ready-${suffix}`);

        expect(await DBOS.retrieveWorkflow(ready.runId).getResult()).toMatchObject({ state: 'regression' });
        expect((await DBOS.getWorkflowStatus(waiting.runId))!.status).toBe('DELAYED');
        expect((await DBOS.getWorkflowStatus(ready.runId))!.workflowID).toBe(ready.runId);
        expect((await DBOS.listWorkflowSteps(ready.runId))!.map((step) => step.name)).toContain('admission:execute');
        await engine.stop({ ...waiting, headSha: waiting.pullRequest.headSha }, 'cancelled', 'integration complete');
    }, 60_000);

    it('a setup and Run share one execution budget instead of two independently full queues', async () => {
        limits.globalExecuting = 1;
        await (await DBOS.retrieveQueue(EXECUTION_QUEUE))!.setPartitionConcurrency(1);
        await (await DBOS.retrieveQueue(EXECUTION_QUEUE))!.setGlobalConcurrency(1);
        const key = `admission-setup-${Date.now()}`;
        const cmd: RuntimeEnvironmentSetupRequested = { environmentId: key, organizationId: `setup-${key}`, teamId: 'team', repositoryId: 'repo', repositoryName: 'shop',
            requestedBy: { userId: 'user' }, requestedAt: new Date().toISOString(), key, ref: { sha: 'c'.repeat(40), branch: 'main' } };
        await engine.startSetup(cmd);
        await until(async () => setupActive);
        const run = await request(`ready-${key}`);
        await until(async () => (await store.get({ organizationId: run.organizationId, kind: 'run', key: run.runId }))!.generation > 0);
        expect((await DBOS.getWorkflowStatus(run.runId))!.status).toBe('DELAYED');

        releaseSetup!();
        expect(await DBOS.retrieveWorkflow(setupWorkflowId(key)).getResult()).toMatchObject({ state: 'active' });
        expect(await DBOS.retrieveWorkflow(run.runId).getResult()).toMatchObject({ state: 'regression' });
        limits.globalExecuting = 2;
        await (await DBOS.retrieveQueue(EXECUTION_QUEUE))!.setGlobalConcurrency(2);
        await (await DBOS.retrieveQueue(EXECUTION_QUEUE))!.setPartitionConcurrency(2);
    }, 60_000);

    it('keeps the fork gate and approved native IDs while replacing expired sealed input once', async () => {
        const req = await request(`ready-fork-${Date.now()}`, new Date().toISOString(), {
            pullRequest: { number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), fork: true },
        });
        await until(async () => (await memory.projection.get(req.runId))?.state === 'awaiting_approval');
        expect(await DBOS.getWorkflowStatus(approvedRunWorkflowId(req.runId))).toBeNull();
        const fresh = shopRunRequest({ runId: req.runId });
        await engine.approve(req.runId, req.pullRequest.headSha, `approve-${req.runId}`, { repoToken: fresh.repoToken, runToken: fresh.runToken });

        expect(await DBOS.retrieveWorkflow(req.runId).getResult()).toMatchObject({ state: 'regression' });
        expect(await DBOS.retrieveWorkflow(approvedRunWorkflowId(req.runId)).getResult()).toMatchObject({ state: 'regression' });
        const row = await store.get({ organizationId: req.organizationId, kind: 'run', key: req.runId });
        expect(row).toMatchObject({ executionId: approvedRunWorkflowId(req.runId), payload: { kind: 'run', request: { repoToken: fresh.repoToken, runToken: fresh.runToken }, options: { forkApproved: true } } });
        expect(forRun.mock.calls.filter(([r]) => r.runId === req.runId).at(-1)?.[0].repoToken).toBe(fresh.repoToken);
        const before = forRun.mock.calls.length;
        await engine.start(req);
        expect(forRun).toHaveBeenCalledTimes(before);
    }, 60_000);

    it('cancelling accepted delayed work keeps its original native handle terminal', async () => {
        const req = await request(`wait-cancel-${Date.now()}`);
        await engine.stop({ ...req, headSha: req.pullRequest.headSha }, 'cancelled', 'closed');

        expect((await DBOS.getWorkflowStatus(req.runId))!.status).toBe('CANCELLED');
        await expect(DBOS.retrieveWorkflow(req.runId).getResult()).rejects.toThrow();
        await engine.repairAdmission();
        expect((await DBOS.getWorkflowStatus(req.runId))!.status).toBe('CANCELLED');
    }, 30_000);

    it('an already-expired admission reaches a native timed-out result without executing Run work', async () => {
        const before = forRun.mock.calls.length;
        const req = await request(`ready-expired-${Date.now()}`, new Date(Date.now() - ADMISSION_WAIT_MS - 1).toISOString());

        expect(await DBOS.retrieveWorkflow(req.runId).getResult()).toMatchObject({ state: 'timed_out' });
        expect(forRun).toHaveBeenCalledTimes(before);
    }, 30_000);

    it('repairs a terminal admission attempt that failed before take without replacing the execution ID', async () => {
        jest.spyOn(store, 'take').mockRejectedValueOnce(new Error('synthetic transient take failure'));
        const req = await request(`ready-repair-${Date.now()}`);
        const ref: AdmissionRef = { organizationId: req.organizationId, kind: 'run', key: req.runId };
        const failed = admissionAttemptWorkflowId(ref, 0, 0);
        await until(async () => (await DBOS.getWorkflowStatus(failed))?.status === 'ERROR');

        await engine.repairAdmission();

        expect(await DBOS.retrieveWorkflow(req.runId).getResult()).toMatchObject({ state: 'regression' });
        expect(forRun.mock.calls.filter(([request]) => request.runId === req.runId)).toHaveLength(1);
        jest.restoreAllMocks();
    }, 60_000);
});
