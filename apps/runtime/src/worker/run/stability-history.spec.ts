import { NORMALIZER_VERSION, StabilityRecord } from '@libs/runtime/gate';

import { shopRunRequest } from '../../e2e/fixtures';
import type { StabilityHistory, StabilityOutcome } from './ports';
import { runRuntimeRun } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

/** The store's contract in memory: org and environment scoped, idempotent per Run and probe index. */
class MemoryStability implements StabilityHistory {
    rows: Array<StabilityOutcome & { orgId: string; environmentId: string; runId: string }> = [];
    reads: Array<{ orgId: string; environmentId: string; keys: string[] }> = [];
    async read(scope: { orgId: string; environmentId: string }, probeKeys: string[]) {
        this.reads.push({ ...scope, keys: probeKeys });
        const out: Record<string, StabilityRecord[]> = {};
        for (const k of probeKeys) {
            out[k] = this.rows
                .filter((r) => r.orgId === scope.orgId && r.environmentId === scope.environmentId && r.probeKey === k)
                .map((r) => ({ normalizerVersion: r.normalizerVersion, unstableFields: r.unstableFields, verdict: r.verdict }));
        }
        return out;
    }
    async record(scope: { orgId: string; environmentId: string; runId: string }, outcomes: StabilityOutcome[]) {
        for (const o of outcomes) {
            if (!this.rows.some((r) => r.runId === scope.runId && r.probeIndex === o.probeIndex && r.orgId === scope.orgId)) this.rows.push({ ...scope, ...o });
        }
    }
}

describe('a Run with the stability history (ADR-050)', () => {
    it('records on every verdict the normalizer version and the policy it started from, and the outcome of each probe', async () => {
        const h = inMemoryRunDeps();
        const stability = new MemoryStability();
        h.deps.stability = stability;
        const names: string[] = [];
        const step = h.deps.step;
        h.deps.step = (name, fn) => (names.push(name), step(name, fn));
        const req = shopRunRequest();

        await runRuntimeRun(req, h.deps);

        const run = (await h.projection.get(req.runId))!;
        expect(run.probes!.length).toBeGreaterThan(0);
        for (const p of run.probes!) {
            expect(p.normalizerVersion).toBe(NORMALIZER_VERSION);
            expect(JSON.parse(p.stabilityPolicy!)).toMatchObject({ v: 1, baseRounds: 2, knownUnstableFields: [], historyRuns: 0 });
        }
        expect(stability.reads).toEqual([{ orgId: req.organizationId, environmentId: req.environment.environmentId, keys: expect.any(Array) }]);
        expect(stability.rows.length).toBe(run.probes!.length);
        expect(stability.rows.every((r) => r.orgId === req.organizationId && r.runId === req.runId && r.normalizerVersion === NORMALIZER_VERSION)).toBe(true);
        // One read before the first replayed round, one record after the last verdict.
        const read = names.indexOf('stability:read');
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(names.findIndex((n) => n.startsWith('probe:') && !n.endsWith(':base:1')));
        expect(names.indexOf('stability:record')).toBeGreaterThan(names.map((n) => n.startsWith('probe:')).lastIndexOf(true));
    });

    it('starts a probe whose base varied in an earlier Run of the environment with one more base round', async () => {
        const h = inMemoryRunDeps();
        const stability = new MemoryStability();
        h.deps.stability = stability;
        const req = shopRunRequest();
        await runRuntimeRun(req, h.deps);
        const first = stability.rows[0];
        // Another org's history of the same shape is never read.
        stability.rows = [
            { ...first, runId: 'earlier', unstableFields: ['json.requestId'] },
            { ...first, orgId: 'other-org', runId: 'other', unstableFields: ['json.other'] },
        ];

        const again = inMemoryRunDeps();
        again.deps.stability = stability;
        const next = { ...shopRunRequest(), runId: '0b5c7a2e-8d3f-4e1a-9c6b-1f2e3d4c5b6a' };
        await runRuntimeRun(next, again.deps);

        const run = (await again.projection.get(next.runId))!;
        const probe = run.probes!.find((_, i) => i === first.probeIndex)!;
        expect(JSON.parse(probe.stabilityPolicy!)).toMatchObject({ baseRounds: 3, knownUnstableFields: ['json.requestId'], historyRuns: 1 });
        expect(probe.baseStepIds!.length).toBeGreaterThanOrEqual(3);
    });

    it('without a store keeps the table default and plays no history step', async () => {
        const h = inMemoryRunDeps();
        const names: string[] = [];
        const step = h.deps.step;
        h.deps.step = (name, fn) => (names.push(name), step(name, fn));
        const req = shopRunRequest();
        await runRuntimeRun(req, h.deps);
        expect(names.filter((n) => n.startsWith('stability:'))).toEqual([]);
        const run = (await h.projection.get(req.runId))!;
        expect(run.probes!.every((p) => p.normalizerVersion === NORMALIZER_VERSION && !!p.stabilityPolicy)).toBe(true);
    });
});
