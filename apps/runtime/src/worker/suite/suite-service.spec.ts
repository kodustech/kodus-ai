import type { AcquireRequest, ExecRequest } from '@libs/runtime/environment';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteBaselines, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { SuiteService, type SuiteServiceDeps } from './suite-service';

// The workflow body of a suite run (docs/runtime/e2e-suites.md section 11): read the recipe's suite block, list the specs on
// a template host, run the engine, keep what the engine decided. Real engine and stores' twins; a fake cell.

const ORG = 'org-a';
const ENV = 'env-shop';
const MAIN = 'a'.repeat(40);
const PR = 'b'.repeat(40);
const RECIPE = `version: 1
services:
  compose:
    public: app
suite:
  runner: cypress
  command: fake-runner --specs "{specs}"
  cwd: apps/dashboard
  specs: "cypress/e2e/**/*.cy.ts"
  shards: 1
`;
const passthrough = <T>(_name: string, fn: () => Promise<T>) => fn();
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', repositoryFullName: 'acme/shop', mode: 'ci', prNumber: 7, prSha: PR, mergeBase: MAIN, mainSha: MAIN,
    requestedAt: '2026-11-23T12:00:00.000Z', key: 'sr-1', repoToken: 'sealed:v1:t0', moreRepoTokens: ['sealed:v1:t1', 'sealed:v1:t2', 'sealed:v1:t3', 'sealed:v1:t4'], ...over,
});

function world(over: { recipe?: string | null; ready?: boolean; specs?: FakeSuiteWorld['specs']; main?: string[]; setupMissing?: boolean; publisher?: boolean } = {}) {
    const published: string[] = [];
    const clock = new SuiteClock();
    const main = over.main ?? ['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts'];
    const specs = over.specs ?? Object.fromEntries(main.map((p) => [p.replace(/^apps\/dashboard\//, ''), {}]));
    const cell = new FakeSuiteCell(clock, { specs });
    const tokens: string[] = [];
    const baselineStarted: string[] = [];
    const listing = main.map((p) => `  100 ${p}`).join('\n') + '\n  200 total\n';
    const env = {
        acquire: (r: AcquireRequest) => cell.acquire(r),
        release: (c: string) => cell.release(c),
        exec: async (c: string, r: ExecRequest) => (r.stepId.endsWith('-list') ? { stepId: r.stepId, exitCode: 0, stdout: listing, stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const } : cell.exec(c, r)),
    };
    const runs = new InMemorySuiteRuns(clock);
    const baselines = new InMemorySuiteBaselines();
    const demand = new FakeSuiteDemand(clock);
    const deps: SuiteServiceDeps = {
        setups: { get: async () => (over.setupMissing ? null : ({ environmentId: ENV, organizationId: ORG, imageId: 'img-1', expose: [], recipe: { path: '.kodus/workspace.yaml', sha: MAIN, state: over.recipe === null ? 'absent' : 'found', content: over.recipe ?? RECIPE } } as never)) },
        environment: (ctx) => {
            tokens.push(...ctx.tokens);
            return env;
        },
        demand: () => demand,
        runs,
        stats: new InMemorySuiteSpecStats(),
        baselines,
        templates: { hasReady: async () => over.ready ?? true },
        baselineRequests: { markStarted: async (_o, _e, sha) => void baselineStarted.push(sha) },
        clock,
        ...(over.publisher ? { publisher: { started: async (c) => void published.push(`started:${c.mode}`), finished: async (_c, r, s) => void published.push(`finished:${r.status}:${s.cwd}`) } } : {}),
    };
    return { service: new SuiteService(deps), cell, runs, baselines, demand, tokens, baselineStarted, published };
}

describe('running a suite as a workflow', () => {
    it('lists the specs of main on a template host, runs them in the PR claim and ends the run with its state', async () => {
        const w = world();
        const out = await w.service.run(request(), passthrough);
        expect(out).toMatchObject({ status: 'ran', suiteRunId: 'sr-1', state: 'passed', replayed: false });
        expect(w.cell.starts.flatMap((s) => s.specs).sort()).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']);
        expect((await w.runs.get(ORG, 'sr-1'))?.state).toBe('passed');
        // The listing host and every claim are released and the demand ended.
        expect(w.demand.ended).toBe(1);
        expect(w.cell.claims.size).toBe(w.cell.released.length);
    });

    it('runs a spec the PR adds, and leaves out one the PR removes', async () => {
        const w = world({ specs: { 'cypress/e2e/a.cy.ts': {}, 'cypress/e2e/new.cy.ts': {} } });
        await w.service.run(request({ changedFiles: ['apps/dashboard/cypress/e2e/new.cy.ts'], removedFiles: ['apps/dashboard/cypress/e2e/b.cy.ts'] }), passthrough);
        expect(w.cell.starts.flatMap((s) => s.specs).sort()).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/new.cy.ts']);
    });

    it('a baseline is the whole suite on main, recorded for the baseline request, which is marked started', async () => {
        const w = world();
        const out = await w.service.run(request({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), passthrough);
        expect(out).toMatchObject({ status: 'ran', state: 'passed' });
        expect(w.baselineStarted).toEqual([MAIN]);
        expect([...w.baselines.rows.values()]).toEqual([expect.objectContaining({ mainSha: MAIN, status: 'complete' })]);
    });

    it('a baseline of an environment whose suite sets baseline false runs nothing', async () => {
        const w = world({ recipe: `${RECIPE}  baseline: false\n` });
        const out = await w.service.run(request({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), passthrough);
        expect(out).toEqual({ status: 'off', reason: 'baseline_disabled' });
        expect(w.cell.acquires).toEqual([]);
        expect(w.baselineStarted).toEqual([MAIN]);
    });

    it('does nothing for an environment whose recipe declares no suite, or has no recipe, or is unknown', async () => {
        for (const w of [world({ recipe: 'version: 1\nservices:\n  compose:\n    public: app\n' }), world({ recipe: null }), world({ setupMissing: true })]) {
            const out = await w.service.run(request(), passthrough);
            expect(out).toMatchObject({ status: 'off' });
            expect(w.cell.acquires).toEqual([]);
            expect(await w.runs.get(ORG, 'sr-1')).toBeNull();
        }
    });

    it('with no ready template the run ends neutral and says why, since nothing can list the specs', async () => {
        const w = world({ ready: false });
        const out = await w.service.run(request(), passthrough);
        expect(out).toMatchObject({ status: 'unavailable', reason: 'template_missing', state: 'neutral' });
        expect((await w.runs.get(ORG, 'sr-1'))?.state).toBe('neutral');
        expect(w.demand.ended).toBe(1);
    });

    it('hands the environment every sealed token of the command, the first one first', async () => {
        const w = world();
        await w.service.run(request(), passthrough);
        expect(w.tokens).toEqual(['sealed:v1:t0', 'sealed:v1:t1', 'sealed:v1:t2', 'sealed:v1:t3', 'sealed:v1:t4']);
    });

    it('a retry runs only the specs it names and keeps the digest of the whole suite', async () => {
        const w = world();
        await w.service.run(request({ specs: ['cypress/e2e/b.cy.ts'] }), passthrough);
        expect(w.cell.starts.flatMap((s) => s.specs)).toEqual(['cypress/e2e/b.cy.ts']);
    });

    it('asked again after it finished, answers the finished run and runs nothing', async () => {
        const w = world();
        await w.service.run(request(), passthrough);
        const starts = w.cell.starts.length;
        const again = await w.service.run(request(), passthrough);
        expect(again).toMatchObject({ status: 'ran', state: 'passed', replayed: true });
        expect(w.cell.starts).toHaveLength(starts);
    });

    it('a request without the repository name cannot fetch it: neutral, with the reason', async () => {
        const w = world();
        const out = await w.service.run(request({ repositoryFullName: undefined }), passthrough);
        expect(out).toMatchObject({ status: 'unavailable', reason: 'no_repository', state: 'neutral' });
        expect(w.cell.acquires).toEqual([]);
    });

    it('opens the check before the engine runs and closes it after, each as a publish step, with the suite directory for the annotation paths', async () => {
        const w = world({ publisher: true });
        const steps: string[] = [];
        await w.service.run(request(), async (name, fn) => {
            steps.push(name);
            return fn();
        });
        expect(steps).toEqual(['suite:start', 'publish:suite-started', 'suite:run', 'publish:suite-final']);
        expect(w.published).toEqual(['started:ci', 'finished:ran:apps/dashboard']);
    });

    it('publishes the reason a run could not start, and nothing for an environment with no suite', async () => {
        const unavailable = world({ ready: false, publisher: true });
        await unavailable.service.run(request(), passthrough);
        expect(unavailable.published).toEqual(['started:ci', 'finished:unavailable:apps/dashboard']);
        const off = world({ recipe: null, publisher: true });
        await off.service.run(request(), passthrough);
        expect(off.published).toEqual([]);
    });
});
