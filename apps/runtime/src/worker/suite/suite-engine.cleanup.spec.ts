import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine } from './suite-engine';

// A suite run that ends, however it ends, gives back what it held: the claims the hub still has for it (the engine may
// have lost track of some, after a restart), its demand, and its shards. dev, 2026-11-28: a baseline whose recovered
// workflow threw left the run `requested`, its shards `running` and its three hosts up until the claims' hard expiry.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 2 };
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1',
    organizationId: ORG,
    environmentId: ENV,
    repositoryId: 'repo-1',
    mode: 'baseline',
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-28T12:00:00.000Z',
    key: 'sr-1',
    ...over,
});

function world(spec: FakeSuiteWorld, held: string[] = []) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, spec);
    const runs = new InMemorySuiteRuns(clock);
    const demand = new FakeSuiteDemand(clock);
    const asked: Array<[string, string]> = [];
    const claims = {
        forRun: async (organizationId: string, runId: string) => {
            asked.push([organizationId, runId]);
            return held.map((claimId) => ({ claimId, side: 'pr' }));
        },
    };
    const engine = new SuiteEngine({ env: cell, runs, stats: new InMemorySuiteSpecStats(), demand, clock, claims });
    const inputs = { config, specs: ['a.cy.ts', 'b.cy.ts'].map((path) => ({ path, sizeBytes: 100 })) };
    return { clock, cell, runs, demand, engine, inputs, asked };
}

describe('what a suite run gives back when it ends', () => {
    it('releases every claim the hub still holds for the run, including one this engine never heard of, and ends its demand', async () => {
        const w = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': {} } }, ['claim:from-a-process-that-died']);
        await w.engine.run(request(), w.inputs);
        expect(w.cell.released).toContain('claim:from-a-process-that-died');
        // The ones it acquired itself are released too, once.
        for (const c of w.cell.claims.keys()) expect(w.cell.released.filter((r) => r === c)).toHaveLength(1);
        expect(w.demand.ended).toBe(1);
        expect(w.asked).toEqual([[ORG, 'sr-1']]);
    });

    it('a first pass that throws ends the run errored, closes its shards, and still releases its claims and ends its demand', async () => {
        const w = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': {} } }, ['claim:held-by-hub']);
        w.cell.acquire = async () => {
            throw new Error('hub answered 500');
        };
        await expect(w.engine.run(request(), w.inputs)).rejects.toThrow('hub answered 500');
        const run = await w.runs.get(ORG, 'sr-1');
        expect(run?.state).toBe('errored');
        expect(run?.finishedAt).toBeDefined();
        expect((await w.runs.shards(ORG, 'sr-1')).map((s) => s.state)).toEqual(['finished', 'finished']);
        expect(w.cell.released).toContain('claim:held-by-hub');
        expect(w.demand.ended).toBe(1);
    });

    it('a release that fails never stops the others or the end of the demand', async () => {
        const w = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': {} } }, ['claim:one', 'claim:two']);
        const release = w.cell.release.bind(w.cell);
        w.cell.release = async (id: string) => {
            if (id === 'claim:one') throw new Error('hub unreachable');
            return release(id);
        };
        await w.engine.run(request(), w.inputs);
        expect(w.cell.released).toContain('claim:two');
        expect(w.demand.ended).toBe(1);
    });

    it('a run that finished by itself keeps the state it concluded with', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: [{ fail: 'boom' }], main: [{ fail: 'boom' }] }, 'b.cy.ts': {} } });
        const out = await w.engine.run(request(), w.inputs);
        expect((await w.runs.get(ORG, 'sr-1'))?.state).toBe(out.state);
        expect(out.state).not.toBe('errored');
    });
});
