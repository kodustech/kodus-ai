import { DBOS } from '@dbos-inc/dbos-sdk';

import { FakeEnvironmentRuntime } from '@libs/runtime/environment';
import type { RuntimeRunRequested } from '@libs/runtime/run';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { ensureDatabase } from '../../shared/runtime-schema';
import { inMemoryRunDeps } from '../run/in-memory-deps';
import { finalizeStoppedRun, runRuntimeRun } from '../run/run-orchestrator';

// The DBOS PoC of ADR-046 / T6 against a real Postgres (the Runtime one of
// docker-compose.runtime.yml): fair queue per org, cancel in the middle of a
// Run, and the checkpoint cost of a 200-step workflow.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const order: string[] = [];
const fairTask = DBOS.registerWorkflow(
    async (org: string, id: string) => {
        await DBOS.runStep(async () => void order.push(`${org}:${id}`), { name: 'start' });
        await DBOS.sleep(400);
        return id;
    },
    { name: 'it_fair_task' },
);

const manySteps = DBOS.registerWorkflow(
    async (n: number) => {
        let total = 0;
        for (let i = 0; i < n; i++) total += await DBOS.runStep(async () => i, { name: `s${i}` });
        return total;
    },
    { name: 'it_many_steps' },
);

// A Run whose probes are slow, so it can be cancelled in the middle.
const slowEnv = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
const probe = slowEnv.probe.bind(slowEnv);
slowEnv.probe = async (...args) => {
    await sleep(300);
    return probe(...args);
};
const slow = inMemoryRunDeps({ env: slowEnv });
const dbosStep = <T>(name: string, fn: () => Promise<T>) => DBOS.runStep(fn, { name });
const runWorkflow = DBOS.registerWorkflow(async (req: RuntimeRunRequested) => runRuntimeRun(req, { ...slow.deps, step: dbosStep }), {
    name: 'it_runtime_run',
});

(skip ? describe.skip : describe)('DBOS run engine (integration, real Postgres)', () => {
    beforeAll(async () => {
        await ensureDatabase(url);
        // A version per run: workflows left PENDING by an earlier run are never recovered into this one.
        DBOS.setConfig({ name: 'kody-runtime-it', systemDatabaseUrl: url, logLevel: 'error', applicationVersion: `it-${Date.now()}` });
        await DBOS.launch();
        await DBOS.registerQueue('it-fair', { concurrency: 2, partitionConcurrency: 1, onConflict: 'always_update' });
        await DBOS.registerQueue('it-runs', { concurrency: 4, partitionConcurrency: 2, onConflict: 'always_update' });
    }, 60_000);

    afterAll(async () => {
        await DBOS.shutdown();
    });

    it('a busy org does not hold the queue of another org (partition by org)', async () => {
        const suffix = Date.now();
        const handles = [];
        for (const [org, id] of [['org-a', 'a1'], ['org-a', 'a2'], ['org-a', 'a3'], ['org-b', 'b1']]) {
            handles.push(
                await DBOS.startWorkflow(fairTask, { workflowID: `fair-${id}-${suffix}`, queueName: 'it-fair', enqueueOptions: { queuePartitionKey: org } })(org, id),
            );
        }
        await Promise.all(handles.map((h) => h.getResult()));
        // org-b enqueued last, but runs in the first wave: one slot per org.
        expect(order.slice(0, 2).sort()).toEqual(['org-a:a1', 'org-b:b1']);
        expect(order.slice(2)).toEqual(['org-a:a2', 'org-a:a3']);
    }, 30_000);

    it('the same runId starts the workflow once', async () => {
        const req = shopRunRequest();
        await slow.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        const h1 = await DBOS.startWorkflow(runWorkflow, { workflowID: req.runId, queueName: 'it-runs', enqueueOptions: { queuePartitionKey: req.organizationId } })(req);
        const h2 = await DBOS.startWorkflow(runWorkflow, { workflowID: req.runId, queueName: 'it-runs', enqueueOptions: { queuePartitionKey: req.organizationId } })(req);
        expect(h2.workflowID).toBe(h1.workflowID);
        const result: any = await h1.getResult();
        expect(result.state).toBe('regression');
        const mine = slow.published.filter((p) => p.runId === req.runId);
        // One progress edit per phase (screen 6), then the verdict: one check and one comment.
        expect(mine.filter((p) => p.progress).map((p) => p.progress!.phase)).toEqual(['booting', 'applying', 'testing', 'reporting']);
        expect(mine.filter((p) => !p.progress).map((p) => p.kind)).toEqual(['check', 'comment']);
    }, 60_000);

    it('cancels a Run in the middle, then the stop step supersedes it and releases its claims', async () => {
        const req = shopRunRequest();
        await slow.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        const h = await DBOS.startWorkflow(runWorkflow, { workflowID: req.runId, queueName: 'it-runs', enqueueOptions: { queuePartitionKey: req.organizationId } })(req);
        for (let i = 0; i < 50 && (await slow.projection.get(req.runId))!.state !== 'testing'; i++) await sleep(100);
        expect((await slow.projection.get(req.runId))!.state).toBe('testing');

        await DBOS.cancelWorkflow(req.runId);
        expect((await DBOS.getWorkflowStatus(req.runId))!.status).toBe('CANCELLED');
        await expect(h.getResult()).rejects.toThrow();

        const moved = await finalizeStoppedRun({ ...slow.deps, step: (_n, fn) => fn() }, { ...req, headSha: req.pullRequest.headSha }, 'superseded', 'new push');
        expect(moved).toBe(true);
        expect((await slow.projection.get(req.runId))!.state).toBe('superseded');
        expect(await slow.claims.forRun(req.runId)).toEqual([]);
        // No verdict was published for the cancelled Run, only the cancelled check.
        const mine = slow.published.filter((p) => p.runId === req.runId);
        expect(mine.filter((p) => !p.progress).map((p) => [p.kind, p.check?.conclusion])).toEqual([['check', 'cancelled']]);
    }, 60_000);

    it('checkpoints a 200-step workflow (T6 cost)', async () => {
        const t0 = Date.now();
        const h = await DBOS.startWorkflow(manySteps, { workflowID: `many-${Date.now()}` })(200);
        expect(await h.getResult()).toBe((199 * 200) / 2);
        const ms = Date.now() - t0;
        const steps = await DBOS.listWorkflowSteps(h.workflowID);
        expect(steps!.length).toBe(200);
        console.log(`[T6] 200 checkpointed steps in ${ms} ms (${(ms / 200).toFixed(1)} ms/step)`);
    }, 60_000);
});
