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

    it('an environment with no suite leaves the Run alone', async () => {
        expect((await run(stageOf({ status: 'off' }))).result.state).toBe('no_regressions');
    });

    it('runs the stage once, after the probes, with the Run request and the Run\'s own step runner', async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const { req, h } = await run(stage);
        expect(stage.calls).toEqual([{ runId: req.runId, step: h.deps.step, opts: expect.anything() }]);
    });

    it("tells the stage when the Run's 45 minutes end, less five minutes to judge and publish, so a suite never runs the Run out of time", async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const { projection } = await run(stage);
        const [call] = stage.calls as Array<{ opts: { deadlineAt: string } }>;
        expect(Date.parse(call.opts.deadlineAt)).toBe(Date.parse(projection.bootingAt!) + 40 * 60_000);
    });

    it("hands the stage the Run's cancel signal, so stopping the Run (a newer push) stops the suite", async () => {
        const stage = stageOf({ status: 'ran', state: 'passed' });
        const signal = new AbortController().signal;
        await run(stage, { cancellationSignal: () => signal });
        const [call] = stage.calls as Array<{ opts: { cancellationSignal: () => AbortSignal | undefined } }>;
        expect(call.opts.cancellationSignal()).toBe(signal);
    });
});
