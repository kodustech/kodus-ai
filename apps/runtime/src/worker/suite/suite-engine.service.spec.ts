import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { type SuiteConfig, SuiteEngine, type SuiteInputs } from './suite-engine';
import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteCoverageMaps, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';

// docs/runtime/e2e-suites.md section 4: the suite command runs in the recipe's `service`. Everything the engine asks a
// claim to run (the command, its polls and kill, the result reads, the clear, the coverage read) goes to that service.

const MIN = 60_000;
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 1 };
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1',
    organizationId: 'org-a',
    environmentId: 'env-shop',
    repositoryId: 'repo-1',
    mode: 'ci',
    prNumber: 7,
    prSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-23T12:00:00.000Z',
    key: 'sr-1',
    ...over,
});

function world(spec: FakeSuiteWorld, cfg: Partial<SuiteConfig> = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, spec);
    const engine = new SuiteEngine({ env: cell, runs: new InMemorySuiteRuns(clock), stats: new InMemorySuiteSpecStats(), demand: new FakeSuiteDemand(clock), clock, maps: new InMemorySuiteCoverageMaps() });
    return { cell, run: (specs: string[], over: Partial<SuiteInputs> = {}, req: Partial<RuntimeSuiteRequested> = {}) => engine.run(request(req), { config: { ...config, ...cfg }, specs: specs.map((path) => ({ path, sizeBytes: 100 })), ...over }) };
}

describe('the suite engine and the recipe service', () => {
    it('every command it runs in a claim names the recipe service', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 2 * MIN }, 'b.cy.ts': { ms: MIN } } }, { service: 'e2e' });
        const out = await w.run(['a.cy.ts', 'b.cy.ts']);
        expect(out.firstPass.every((s) => s.status === 'passed')).toBe(true);
        const kinds = new Set(w.cell.execServices.map((e) => e.stepId.split(':').slice(1).join(':').replace(/\d+$/, '')));
        // The start, the clear, the polls and the reads of the result files all ran.
        expect(kinds.size).toBeGreaterThanOrEqual(3);
        expect(w.cell.execServices.length).toBeGreaterThan(3);
        expect(w.cell.execServices.filter((e) => e.service !== 'e2e')).toEqual([]);
    });

    it('with no service in the recipe no exec names one', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN } } });
        await w.run(['a.cy.ts']);
        expect(w.cell.execServices.length).toBeGreaterThan(1);
        expect(w.cell.execServices.filter((e) => e.service !== undefined)).toEqual([]);
    });

    it('a baseline with coverage reads the dumps in the service too', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN, covers: ['src/a.ts'] } } }, { service: 'e2e' });
        await w.run(['a.cy.ts'], { coverage: true }, { mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined });
        const cov = w.cell.execServices.filter((e) => e.stepId.endsWith(':cov'));
        expect(cov.length).toBeGreaterThan(0);
        expect(cov.every((e) => e.service === 'e2e')).toBe(true);
    });

    it('a cell that cannot run in a service leaves the specs infra, never a failure of the PR', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN } }, refusesService: true }, { service: 'e2e' });
        const out = await w.run(['a.cy.ts']);
        expect(out.firstPass.map((s) => s.status)).toEqual(['infra']);
    });
});
