import type { KeptCheck } from '@libs/runtime/contracts/kept-check';
import { FakeEnvironmentRuntime, type FakeEnvironment } from '@libs/runtime/environment';
import type { RuntimeRunRequested } from '@libs/runtime/run';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import type { KeptCheckResults } from './ports';
import { runRuntimeRun } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

// A kept check (docs/runtime/kept-checks.md) is played on base and PR after the
// plan's probes, through the same gate, and its outcome reaches the verdict,
// the projection, the report and the results history.

const K = '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d';
const PROBE_ID = `kept:${K}`;
type Answers = NonNullable<FakeEnvironment['probes']>[string];

const json = (status: number, body: string) => () => ({ http: { status, headers: {}, body } });
const keptOrder: Answers = { base: json(200, '{"total":3}'), pr: json(200, '{"total":3}') };

/** The shop where the plan's probes agree on both sides, so only a kept check can tell the PR apart. */
function shop(kept: Answers = keptOrder) {
    const probes = {
        'orders-empty-cart': { base: json(400, '{"error":"cart is empty"}'), pr: json(400, '{"error":"cart is empty"}') },
        'orders-list': SCENARIOS.shop.probes!['orders-list'],
        [PROBE_ID]: kept,
    };
    return new FakeEnvironmentRuntime({ ...SCENARIOS, shop: { ...SCENARIOS.shop, probes } }, () => new Date());
}

const keptCheck = (over: Partial<KeptCheck> = {}): KeptCheck => ({
    keptCheckId: K,
    entryPoint: 'GET /orders/:id',
    probe: {
        spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path: '/orders/1', timeoutMs: 5_000 },
        purpose: 'order 1 totals 3',
        expected: '200',
        compare: ['status', 'json'],
    },
    assertions: { kind: 'http', status: 200 },
    differingFields: ['json.total'],
    sourcePrNumber: 7,
    ...over,
});

const seed = (projection: { upsert: (id: string, p: object) => Promise<unknown> }, req: RuntimeRunRequested) =>
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
    });

async function run(opts: { kept?: Answers; checks?: KeptCheck[]; trigger?: RuntimeRunRequested['trigger']; overBudget?: boolean } = {}) {
    const h = inMemoryRunDeps({ env: shop(opts.kept) });
    const recorded: Parameters<KeptCheckResults['record']>[] = [];
    h.deps.keptCheckResults = { record: async (...args) => void recorded.push(args) };
    if (opts.overBudget) {
        const step = h.deps.step;
        // The phase started longer ago than its budget, as a resumed workflow would read it from its journal.
        h.deps.step = (name, fn) => (name === 'kept:start' ? Promise.resolve(Date.now() - 60 * 60_000) : step(name, fn)) as any;
    }
    const probe = jest.spyOn(h.deps.env, 'probe');
    const req = shopRunRequest({ ...(opts.checks === undefined ? { keptChecks: [keptCheck()] } : opts.checks.length ? { keptChecks: opts.checks } : {}), trigger: opts.trigger ?? 'pull_request' });
    await seed(h.projection, req);
    const result = await runRuntimeRun(req, h.deps);
    const projection = (await h.projection.get(req.runId))!;
    const check = h.published.find((p) => p.kind === 'check' && p.check?.status === 'completed');
    const keptRounds = probe.mock.calls.filter(([, p]) => p.id === PROBE_ID).length;
    return { result, projection, report: check?.report, recorded, keptRounds, req };
}

describe('kept checks in a Run', () => {
    it('a kept check that breaks on a later PR fails the Run as a regression from a kept check', async () => {
        const { result, projection, report, recorded } = await run({ kept: { base: json(200, '{"total":3}'), pr: json(200, '{"total":4}') } });
        expect(result.state).toBe('regression');
        const kept = projection.probes!.find((p) => p.probeId === PROBE_ID)!;
        expect(kept).toMatchObject({ source: 'kept_check', keptCheckId: K, verdict: 'finding', findingKind: 'behavior_change' });
        expect(projection.findings!.map((f) => f.source)).toEqual(['kept_check']);
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'failed', probeId: PROBE_ID }]);
        expect(report!.paths.find((p) => p.probeId === PROBE_ID)).toMatchObject({ source: 'kept_check', keptCheckId: K, verdict: 'finding' });
        expect(report!.keptChecks).toEqual({ played: 1, failed: 1, notRun: [] });
        expect(recorded).toHaveLength(1);
        expect(recorded[0][0]).toMatchObject({ orgId: 'org-demo', environmentId: 'shop', repositoryId: 'repo-shop', prNumber: 42 });
        expect(recorded[0][1]).toEqual([{ keptCheckId: K, outcome: 'failed', sourcePrNumber: 7 }]);
    });

    it('a kept check main and the PR still agree on passes, and leaves the verdict as the plan made it', async () => {
        const without = await run({ checks: [] });
        const { result, projection } = await run();
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'passed', probeId: PROBE_ID }]);
        expect(result.state).toBe(without.result.state);
    });

    it('a kept check whose route main no longer has is stale, reported, and keeps the Run from green', async () => {
        const without = await run({ checks: [] });
        expect(without.result.state).toBe('no_regressions');
        const { result, projection, report } = await run({ kept: { base: json(404, '{"error":"not found"}'), pr: json(404, '{"error":"not found"}') } });
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'stale', staleReason: 'route_gone', probeId: PROBE_ID }]);
        expect(result.state).toBe('partly_tested');
        // A stale check settles nothing of the diff: it is never "not reproduced".
        expect(projection.probes!.find((p) => p.probeId === PROBE_ID)).toMatchObject({ verdict: 'inconclusive', entryPoint: 'unmapped' });
        expect(report!.keptChecks).toEqual({ played: 1, failed: 0, notRun: [{ keptCheckId: K, outcome: 'stale', staleReason: 'route_gone', probeId: PROBE_ID }] });
    });

    it('a kept check main no longer satisfies is stale with baseline_changed, even when the PR restores it', async () => {
        const { result, projection } = await run({ kept: { base: json(500, '{"error":"internal"}'), pr: json(200, '{"total":3}') } });
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'stale', staleReason: 'baseline_changed', probeId: PROBE_ID }]);
        expect(result.state).not.toBe('regression');
    });

    it('a kept check whose target the environment no longer exposes is stale and never played', async () => {
        const moved = keptCheck({ probe: { ...keptCheck().probe, spec: { kind: 'http', target: { service: 'web', port: 4000 }, method: 'GET', path: '/orders/1', timeoutMs: 5_000 } } });
        const { projection, keptRounds, result } = await run({ checks: [moved] });
        expect(keptRounds).toBe(0);
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'stale', staleReason: 'target_gone' }]);
        expect(result.state).toBe('partly_tested');
    });

    it('a kept check the phase budget does not reach is skipped, never passed', async () => {
        const { projection, keptRounds, result } = await run({ overBudget: true });
        expect(keptRounds).toBe(0);
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'skipped' }]);
        expect(result.state).toBe('partly_tested');
    });

    it('a simulation plays kept checks but records no outcome', async () => {
        const { projection, recorded } = await run({ trigger: 'simulate', kept: { base: json(200, '{"total":3}'), pr: json(200, '{"total":4}') } });
        expect(projection.keptChecks).toEqual([{ keptCheckId: K, outcome: 'failed', probeId: PROBE_ID }]);
        expect(recorded).toEqual([]);
    });

    it('a Run without kept checks plays none and records nothing', async () => {
        const { projection, recorded, keptRounds, report } = await run({ checks: [] });
        expect(keptRounds).toBe(0);
        expect(projection.keptChecks).toBeUndefined();
        expect(report!.keptChecks).toBeUndefined();
        expect(recorded).toEqual([]);
    });
});
