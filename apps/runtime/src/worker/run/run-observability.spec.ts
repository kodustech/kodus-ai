import { FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { shopRunRequest } from '../../e2e/fixtures';
import shopTurns from '../agent/fixtures/shop-orders.json';
import { HmacCanaryVault } from '../canary/canary';
import { inMemoryRunDeps } from './in-memory-deps';
import { finalizeStoppedRun, runRuntimeRun } from './run-orchestrator';

// What a Run tells the operator and the Run page about itself: one line per
// comment phase and one canonical line at its end, the agent's exploration
// as evidence, and every evidence write that failed. Before this, a Run
// logged only run.enqueued, and its exploration and failed rounds left
// nothing behind the Run page's links.

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>, patch: Record<string, unknown> = {}) =>
    projection.upsert(req.runId, {
        attempt: req.attempt,
        correlationId: req.correlationId,
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        state: 'queued',
        requestedAt: req.requestedAt,
        ...patch,
    });

class MemoryEvidence {
    readonly objects = new Map<string, any>();
    async put(key: string, body: string | Buffer) {
        this.objects.set(key, JSON.parse(String(body)));
    }
}

/** The model text of every recorded turn: none of it may be logged or kept as evidence. */
const modelText = (shopTurns as Array<{ text: string }>).map((t) => t.text);

describe('the Run log', () => {
    it('logs each comment phase once and one run.finished with what the Run did, ids and numbers only', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        const phases = h.logged.filter((l) => l.msg === 'run.phase');
        expect(phases.map((l) => l.phase)).toEqual(['booting', 'applying', 'testing', 'reporting']);
        for (const p of phases) expect(p).toMatchObject({ runId: req.runId, organizationId: req.organizationId, correlationId: req.correlationId, ms: expect.any(Number) });
        const finished = h.logged.filter((l) => l.msg === 'run.finished');
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({
            runId: req.runId,
            attempt: 1,
            organizationId: req.organizationId,
            environmentId: 'shop',
            trigger: 'pull_request',
            state: 'regression',
            verdictState: 'regression',
            bootMs: expect.any(Number),
            applyMs: expect.any(Number),
            testMs: expect.any(Number),
            reportMs: expect.any(Number),
            totalMs: expect.any(Number),
            probesPlanned: 2,
            probesDecided: 2,
            findings: 1,
            explored: 1,
            exploreFailed: 0,
            // Both plan turns and the intent turn of the recorded fixture.
            inputTokens: 900 + 1_400 + 600,
            outputTokens: 40 + 320 + 10,
            published: ['check', 'comment'],
        });
        // Never the model's words, the diff or a command's output.
        const text = JSON.stringify(h.logged);
        for (const t of modelText) expect(text).not.toContain(t);
        expect(text).not.toContain(req.diff[0].patch);
        expect(text).not.toContain('POST /orders\n');
    });

    it('a Run that could not boot still ends with run.finished', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest({ environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } });
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        expect(h.logged.filter((l) => l.msg === 'run.phase').map((l) => [l.phase, l.ready])).toEqual([['booting', false]]);
        expect(h.logged.filter((l) => l.msg === 'run.finished')).toEqual([
            expect.objectContaining({ state: 'could_not_boot', verdictState: 'could_not_boot', bootMs: expect.any(Number), published: ['check', 'comment'] }),
        ]);
    });

    it('a resumed workflow logs nothing twice: the lines are written from inside their steps', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(h.projection, req);
        const recorded = new Map<string, unknown>();
        const run = h.deps.step;
        // A replay returns what a step recorded without running it again, as DBOS does.
        h.deps.step = (async <T>(name: string, fn: () => Promise<T>) => {
            if (recorded.has(name)) return recorded.get(name) as T;
            const out = await run(name, fn);
            recorded.set(name, out);
            return out;
        }) as typeof h.deps.step;

        await runRuntimeRun(req, h.deps);
        const first = h.logged.length;
        await runRuntimeRun(req, h.deps);

        expect(h.logged.length).toBe(first);
    });

    it('a Run the engine stopped ends with run.finished too', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(h.projection, req, { state: 'booting' });

        await finalizeStoppedRun(h.deps, { ...req, headSha: req.pullRequest.headSha }, 'superseded', 'a newer head');

        expect(h.logged.filter((l) => l.msg === 'run.finished')).toEqual([expect.objectContaining({ runId: req.runId, state: 'superseded', published: ['check'] })]);
    });
});

describe('the agent exploration', () => {
    it('keeps each command and its output as base evidence of its exec step, and lists them on the Run', async () => {
        const evidence = new MemoryEvidence();
        const h = inMemoryRunDeps();
        h.deps.evidence = evidence;
        const req = shopRunRequest();
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        const run = await h.projection.get(req.runId);
        expect(run!.exploration).toEqual([{ index: 0, stepId: expect.any(String), command: 'cat /app/routes.txt', exitCode: 0, durationMs: 5, failed: false }]);
        const body = evidence.objects.get(`${req.organizationId}/${req.runId}/base/${run!.exploration![0].stepId}/output`);
        expect(body).toMatchObject({ kind: 'exploration', index: 0, command: 'cat /app/routes.txt', exitCode: 0, stdout: 'GET /orders\nPOST /orders\n', stderr: '', truncated: false });
        // The model's words are not evidence.
        const all = JSON.stringify([...evidence.objects.values()]);
        for (const t of modelText) expect(all).not.toContain(t);
    });

    it('counts the commands that failed, and the model reads why', async () => {
        const env = new FakeEnvironmentRuntime(
            { ...SCENARIOS, shop: { ...SCENARIOS.shop, exec: () => ({ exitCode: 127, stdout: '', stderr: 'sh: cat: not found\n' }) } },
            () => new Date(),
        );
        const h = inMemoryRunDeps({ env });
        const sent = jest.spyOn(h.llm, 'complete');
        const req = shopRunRequest();
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        expect((await h.projection.get(req.runId))!.exploration![0]).toMatchObject({ exitCode: 127, failed: true });
        expect(h.logged.find((l) => l.msg === 'run.finished')).toMatchObject({ explored: 1, exploreFailed: 1 });
        const observations = JSON.parse(sent.mock.calls[1][0].messages.at(-1)!.content).observations;
        expect(observations).toEqual([{ command: 'cat /app/routes.txt', exitCode: 127, stdout: '', stderr: 'sh: cat: not found\n' }]);
    });
});

describe('the agent exploration and canaries', () => {
    it('a canary the machine printed never reaches the evidence; the Run halts as before', async () => {
        const vault = new HmacCanaryVault();
        const req = shopRunRequest();
        const [npm] = vault.forRun(req);
        const env = new FakeEnvironmentRuntime(
            { ...SCENARIOS, shop: { ...SCENARIOS.shop, exec: () => ({ stdout: `//registry.npmjs.org/:_authToken=${npm.value}\n` }) } },
            () => new Date(),
        );
        const evidence = new MemoryEvidence();
        const h = inMemoryRunDeps({ env, canaries: vault });
        h.deps.evidence = evidence;
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        expect(result.state).toBe('halted');
        expect(evidence.objects.size).toBe(1);
        const text = JSON.stringify([...evidence.objects.values()]).toLowerCase();
        expect(text).not.toContain(npm.core);
        expect(text).toContain('[redacted]');
    });
});

describe('evidence that could not be written', () => {
    it('is logged and counted, and the Run still finishes', async () => {
        const h = inMemoryRunDeps();
        h.deps.evidence = { put: async () => Promise.reject(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })) };
        const counted = jest.spyOn(h.deps.metrics, 'recordEvidenceWriteFailed');
        const req = shopRunRequest();
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        expect(result.state).toBe('regression');
        const warned = h.logged.filter((l) => l.msg === 'evidence.write_failed');
        expect(warned.map((w) => w.kind)).toEqual(expect.arrayContaining(['exploration', 'probe']));
        expect(warned[0]).toMatchObject({ level: 'warn', runId: req.runId, organizationId: req.organizationId, errorCode: 'ENOSPC' });
        expect(counted).toHaveBeenCalledWith({ orgId: req.organizationId, kind: 'probe' });
        expect(counted).toHaveBeenCalledWith({ orgId: req.organizationId, kind: 'exploration' });
    });
});

describe('phase estimates', () => {
    it("the comment carries the median of the environment's last Runs while it boots and applies, and the Run leaves its own", async () => {
        const h = inMemoryRunDeps();
        const earlier = [
            { boot: 50_000, apply: 400_000 },
            { boot: 60_000, apply: 460_000 },
            { boot: 40_000, apply: 30_000 },
        ];
        for (const [i, phaseMs] of earlier.entries()) {
            const old = shopRunRequest({ requestedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() });
            await seed(h.projection, old, { state: 'regression', phaseMs });
        }
        const req = shopRunRequest();
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        const progress = h.published.filter((p) => p.progress).map((p) => [p.progress!.phase, p.progress!.estimates]);
        expect(progress).toEqual([
            ['booting', { bootMs: 50_000, applyMs: 400_000 }],
            ['applying', { bootMs: 50_000, applyMs: 400_000 }],
            ['testing', undefined],
            ['reporting', undefined],
        ]);
        expect((await h.projection.get(req.runId))!.phaseMs).toEqual({ boot: expect.any(Number), apply: expect.any(Number) });
    });

    it('a first Run on the environment has no estimate', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(h.projection, req);

        await runRuntimeRun(req, h.deps);

        expect(h.published.find((p) => p.progress?.phase === 'booting')!.progress).not.toHaveProperty('estimates');
    });
});
