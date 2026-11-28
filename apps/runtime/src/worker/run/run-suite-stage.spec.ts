import { FakeEnvironmentRuntime, type FakeEnvironment } from '@libs/runtime/environment';
import { sealSecret, type RuntimeRunRequested, type SuiteStageResult } from '@libs/runtime/run';
import type { Classification, ClassifiedTest } from '@libs/runtime/suite';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { devSealKey } from '../../testing/dev-seal-key';
import type { SuiteStage } from './ports';
import { runRuntimeRun } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

// docs/runtime/e2e-suites.md section 10.2: in Run mode the suite is a stage of the Run, after the probes. A regression of the
// suite is a finding of kind e2e_regression and the verdict regression; flaky, pre-existing and the rest are no finding; an
// undecided failure with no regression makes the Run partly tested, never no_regressions with part of the suite unknown.

type Answers = NonNullable<FakeEnvironment['probes']>[string];
const json = (status: number, body: string) => () => ({ http: { status, headers: {}, body } });
const same: Answers = { base: json(400, '{"error":"cart is empty"}'), pr: json(400, '{"error":"cart is empty"}') };

/** The shop where every probe agrees on both sides: without the suite the Run is no_regressions. */
const shop = () =>
    new FakeEnvironmentRuntime({ ...SCENARIOS, shop: { ...SCENARIOS.shop, probes: { 'orders-empty-cart': same, 'orders-list': SCENARIOS.shop.probes!['orders-list'] } } }, () => new Date());

const test = (spec: string, cls: ClassifiedTest['class']): ClassifiedTest => ({ spec, title: `${spec} works`, class: cls, blocks: cls === 'regression', finding: cls === 'regression', baseDrift: 0, prSignature: 'expected <n> got <n>' });
const classification = (...tests: ClassifiedTest[]): Classification => ({ tests, massFailure: false, requestTemplateBuild: false });

const withSuite = (req: RuntimeRunRequested): RuntimeRunRequested => ({ ...req, suite: { mainSha: 'c'.repeat(40), repoToken: sealSecret('ghs_s0', devSealKey(), req.runId), moreRepoTokens: [sealSecret('ghs_s1', devSealKey(), req.runId)], changedFiles: ['src/a.ts'] } });

async function run(stage: SuiteStage | undefined, opts: { suite?: boolean; cancellationSignal?: () => AbortSignal | undefined } = {}) {
    const h = inMemoryRunDeps({ env: shop() });
    if (stage) h.deps.suite = stage;
    if (opts.cancellationSignal) h.deps.cancellationSignal = opts.cancellationSignal;
    const base = shopRunRequest();
    const req = opts.suite === false ? base : withSuite(base);
    await h.projection.upsert(req.runId, { attempt: req.attempt, correlationId: req.correlationId, organizationId: req.organizationId, teamId: req.teamId, repositoryId: req.repository.id, repositoryName: req.repository.name, prNumber: req.pullRequest.number, headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId, imageId: req.environment.imageId, state: 'queued', requestedAt: req.requestedAt });
    const result = await runRuntimeRun(req, h.deps);
    const projection = (await h.projection.get(req.runId))!;
    const check = h.published.find((p) => p.kind === 'check' && p.check?.status === 'completed');
    return { result, projection, check, req, h };
}
const stageOf = (outcome: SuiteStageResult | (() => never)): SuiteStage & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, run: async (req, step, opts) => (calls.push({ runId: req.runId, step, ...(opts ? { opts } : {}) }), typeof outcome === 'function' ? outcome() : outcome) };
};

describe('the suite as a stage of the Run', () => {
    it('without a suite section the stage never runs, and the Run is what its probes say', async () => {
        const stage = stageOf({ status: 'ran', state: 'failed', classification: classification(test('a.cy.ts', 'regression')) });
        const { result } = await run(stage, { suite: false });
        expect(stage.calls).toEqual([]);
        expect(result.state).toBe('no_regressions');
        // And a worker with no stage at all leaves a request that carries the section alone.
        expect((await run(undefined)).result.state).toBe('no_regressions');
    });

    it('a regression of the suite is a finding of kind e2e_regression, the verdict regression and a failed check', async () => {
        const { result, projection, check } = await run(stageOf({ status: 'ran', state: 'failed', classification: classification(test('cypress/e2e/a.cy.ts', 'regression')) }));
        expect(result.state).toBe('regression');
        expect(projection.findings!.map((f) => f.findingKind)).toEqual(['e2e_regression']);
        expect(projection.findings![0]).toMatchObject({ entryPoint: 'cypress/e2e/a.cy.ts', verdict: 'finding' });
        expect(check?.check?.conclusion).toBe('failure');
    });

    it('flaky, pre-existing and unconfirmed failures are no finding and leave the Run as its probes made it, except the unconfirmed one, which holds it back from green', async () => {
        const quiet = await run(stageOf({ status: 'ran', state: 'passed', classification: classification(test('a.cy.ts', 'flaky'), test('b.cy.ts', 'pre_existing')) }));
        expect(quiet.result.state).toBe('no_regressions');
        expect(quiet.projection.findings ?? []).toEqual([]);
        const undecided = await run(stageOf({ status: 'ran', state: 'neutral', classification: classification(test('a.cy.ts', 'unclassified'), test('b.cy.ts', 'failed_unconfirmed')) }));
        expect(undecided.result.state).toBe('partly_tested');
        expect(undecided.check?.check?.conclusion).not.toBe('success');
    });

    it('a suite that could not run, or ended before it finished, makes the Run partly tested and never fails it', async () => {
        for (const outcome of [{ status: 'unavailable' as const }, { status: 'ran' as const, state: 'timed_out' as const }, { status: 'ran' as const, state: 'errored' as const }]) {
            const { result } = await run(stageOf(outcome));
            expect(result.state).toBe('partly_tested');
        }
        const thrown = await run(stageOf(() => { throw new Error('the broker is down'); }));
        expect(thrown.result.state).toBe('partly_tested');
    });

    it('a canary found in an artifact of the suite halts the Run, as a canary anywhere else does', async () => {
        const { result, check } = await run(stageOf({ status: 'ran', state: 'failed', leaked: true }));
        expect(result.state).toBe('halted');
        expect(check?.check?.conclusion).not.toBe('success');
    });

    it('hands the stage the Run\'s canaries, so the artifacts it keeps are watched for them', async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        await run(stage);
        const opts = (stage.calls[0] as { opts: { canaries?: unknown[] } }).opts;
        expect(opts.canaries?.length).toBeGreaterThan(0);
    });

    it('an environment with no suite leaves the Run alone', async () => {
        expect((await run(stageOf({ status: 'off' }))).result.state).toBe('no_regressions');
    });

    it("runs the stage once, with the Run request and a step runner of its own: the suite is one step of the Run, so its inner steps never interleave with the Run's", async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const { req, h } = await run(stage);
        expect(stage.calls).toEqual([{ runId: req.runId, step: expect.any(Function), opts: expect.anything() }]);
        expect((stage.calls[0] as { step: unknown }).step).not.toBe(h.deps.step);
    });

    it("tells the stage when the Run's 45 minutes end, less five minutes to judge and publish, counted from the Run's start (the suite starts before the machines have room), so a suite never runs the Run out of time", async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const { projection } = await run(stage);
        const [call] = stage.calls as Array<{ opts: { deadlineAt: string } }>;
        expect(Date.parse(call.opts.deadlineAt)).toBe(Date.parse(projection.startedAt!) + 40 * 60_000);
    });

    it("hands the stage the Run's cancel signal, so stopping the Run (a newer push) stops the suite", async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const signal = new AbortController().signal;
        await run(stage, { cancellationSignal: () => signal });
        const [call] = stage.calls as Array<{ opts: { cancellationSignal: () => AbortSignal | undefined } }>;
        expect(call.opts.cancellationSignal()!.aborted).toBe(false);
    });

    it('the signal the stage reads follows the Run\'s: aborting the Run\'s aborts the stage\'s', async () => {
        const parent = new AbortController();
        const stage = stageOf({ status: 'ran', state: 'passed' });
        await run(stage, { cancellationSignal: () => parent.signal });
        const [call] = stage.calls as Array<{ opts: { cancellationSignal: () => AbortSignal | undefined } }>;
        parent.abort();
        expect(call.opts.cancellationSignal()!.aborted).toBe(true);
    });
});

// The suite starts with the Run, not after its probes (docs/runtime/e2e-suites.md sections 2.2, 11 and 12): the stage runs while
// the Run boots, probes and judges intent, and the verdict joins it. The suite is one step of the workflow (as the early plan is),
// so which of its inner steps ran when never decides the order of the Run's own step ids.
describe('the suite runs beside the Run, joined before the verdict', () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /** The shop whose base side takes `ms` to boot, and the order in which the Run reached the machines and the stage. */
    const slowBoot = (ms: number, events: string[]) => {
        const env = shop();
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) => {
            events.push(`acquire:${r.ref.side}`);
            await sleep(ms);
            return acquire(r);
        };
        return env;
    };

    async function runWith(env: ReturnType<typeof shop>, stage: SuiteStage, cancellationSignal?: () => AbortSignal | undefined, mutate: (r: RuntimeRunRequested) => RuntimeRunRequested = (r) => r, arrange?: (h: ReturnType<typeof inMemoryRunDeps>) => void) {
        const h = inMemoryRunDeps({ env });
        arrange?.(h);
        h.deps.suite = stage;
        if (cancellationSignal) h.deps.cancellationSignal = cancellationSignal;
        const req = mutate(withSuite(shopRunRequest()));
        await h.projection.upsert(req.runId, { attempt: req.attempt, correlationId: req.correlationId, organizationId: req.organizationId, teamId: req.teamId, repositoryId: req.repository.id, repositoryName: req.repository.name, prNumber: req.pullRequest.number, headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId, imageId: req.environment.imageId, state: 'queued', requestedAt: req.requestedAt });
        const t0 = Date.now();
        const result = await runRuntimeRun(req, h.deps).catch((e) => ({ thrown: e as Error }));
        return { result, ms: Date.now() - t0, projection: (await h.projection.get(req.runId))! };
    }

    it('starts the suite before the Run boots its machines, not after its probes', async () => {
        const events: string[] = [];
        const stage: SuiteStage = { run: async () => (events.push('suite:start'), { status: 'ran', state: 'passed' }) };
        await runWith(slowBoot(1, events), stage);
        expect(events.indexOf('suite:start')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('suite:start')).toBeLessThan(events.indexOf('acquire:base'));
    });

    it('takes about the longer of the Run and the suite, not their sum', async () => {
        const N = 400;
        const slow: SuiteStage = { run: async () => (await sleep(N), { status: 'ran', state: 'passed' }) };
        const fast: SuiteStage = { run: async () => ({ status: 'ran', state: 'passed' }) };
        const alone = await runWith(slowBoot(N, []), fast);
        const both = await runWith(slowBoot(N, []), slow);
        // The Run alone takes M (at least N, from the boot); with a suite of N beside it, it must not take M + N.
        expect(both.ms).toBeLessThan(alone.ms + N * 0.6);
        expect(both.result).toMatchObject({ state: 'no_regressions' });
    });

    it('still waits for a suite that outlasts the Run, and the verdict carries its result', async () => {
        const stage: SuiteStage = { run: async () => (await sleep(150), { status: 'ran', state: 'failed', classification: classification(test('cypress/e2e/a.cy.ts', 'regression')) }) };
        const { result, projection } = await runWith(slowBoot(1, []), stage);
        expect(result).toMatchObject({ state: 'regression' });
        expect(projection.findings!.map((f) => f.findingKind)).toEqual(['e2e_regression']);
    });

    it("a suite that throws leaves the Run's own probe results as they are", async () => {
        const ok = await runWith(slowBoot(1, []), { run: async () => ({ status: 'ran', state: 'passed' }) });
        const broken = await runWith(slowBoot(1, []), { run: async () => { throw new Error('the broker is down'); } });
        const verdicts = (p: typeof ok.projection) => (p.probes ?? []).map((x) => ({ probeId: x.probeId, verdict: x.verdict, reason: x.reason }));
        expect(verdicts(broken.projection)).toEqual(verdicts(ok.projection));
        expect(verdicts(ok.projection).length).toBeGreaterThan(0);
        expect(broken.result).toMatchObject({ state: 'partly_tested' });
    });

    it('a Run that is cancelled while it boots cancels its suite and ends only when the suite has stopped', async () => {
        const cancel = new AbortController();
        const events: string[] = [];
        const stage: SuiteStage = {
            run: async (_req, _step, opts) => {
                const signal = opts!.cancellationSignal!()!;
                await new Promise<void>((done) => (signal.aborted ? done() : signal.addEventListener('abort', () => done(), { once: true })));
                await sleep(30);
                events.push('suite:stopped');
                throw Object.assign(new Error('cancelled'), { name: 'CancelledError' });
            },
        };
        // The workflow is cancelled while the Run's own step runs: DBOS aborts the step's signal and throws at the next step.
        const { result } = await runWith(shop(), stage, () => cancel.signal, undefined, (h) => {
            const step = h.deps.step;
            h.deps.step = async (name, fn) => {
                if (name === 'log:booted') {
                    await sleep(20);
                    cancel.abort();
                    throw Object.assign(new Error('workflow cancelled'), { name: 'DBOSWorkflowCancelledError' });
                }
                return step(name, fn);
            };
        });
        events.push('run:ended');
        expect(result).toEqual({ thrown: expect.objectContaining({ name: 'DBOSWorkflowCancelledError' }) });
        expect(events).toEqual(['suite:stopped', 'run:ended']);
    });

    it('a Run that ends before its verdict (its base does not boot) stops the suite it started', async () => {
        let stopped = false;
        const stage: SuiteStage = {
            run: async (_req, _step, opts) => {
                await new Promise<void>((done) => opts!.cancellationSignal!()!.addEventListener('abort', () => done(), { once: true }));
                stopped = true;
                return { status: 'ran', state: 'cancelled' };
            },
        };
        await runWith(shop(), stage, undefined, (r) => ({ ...r, environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } }));
        expect(stopped).toBe(true);
    });
});
