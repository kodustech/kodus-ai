import type { AcquireRequest, ExecRequest } from '@libs/runtime/environment';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { suiteDigestOf } from '@libs/runtime/suite';

import { InMemoryEvidenceStore } from '../../shared/evidence/testing';

import { suiteConfigOf } from './suite-config';
import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteBaselines, InMemorySuiteCoverageMaps, InMemorySuiteRuns, InMemorySuiteSelectionState, InMemorySuiteShadows, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
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

const cancelError = () => Object.assign(new Error('workflow cancelled'), { name: 'DBOSWorkflowCancelledError' });

function world(over: { recipe?: string | null; ready?: boolean; specs?: FakeSuiteWorld['specs']; main?: string[]; setupMissing?: boolean; publisher?: boolean; map?: any; maps?: InMemorySuiteCoverageMaps; evidence?: InMemoryEvidenceStore; shots?: Record<string, Buffer>; shadow?: { shadows: InMemorySuiteShadows; selection: InMemorySuiteSelectionState; alerts?: unknown[] } } = {}) {
    const published: string[] = [];
    const finishedStates: string[] = [];
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
        exec: async (c: string, r: ExecRequest) => {
            // The artifact keeper's reads: the files the runner left for the failed spec.
            if (r.stepId.includes(':art-list:')) return { stepId: r.stepId, exitCode: 0, stdout: Object.entries(over.shots ?? {}).map(([p, b]) => `${b.length} ${p}`).join('\n') + '\n', stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const };
            if (r.stepId.includes(':art-read:')) {
                const file = Object.entries(over.shots ?? {}).find(([p]) => r.command.includes(p));
                return { stepId: r.stepId, exitCode: 0, stdout: file ? file[1].toString('hex') : '', stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const };
            }
            return exec2(c, r);
        },
    };
    const exec2 = async (c: string, r: ExecRequest) => (r.stepId.endsWith('-list') ? { stepId: r.stepId, exitCode: 0, stdout: listing, stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const } : cell.exec(c, r));
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
        ...(over.evidence ? { evidence: over.evidence } : {}),
        ...(over.shadow ? { shadows: over.shadow.shadows, selection: over.shadow.selection, alerts: (e: unknown) => void over.shadow!.alerts?.push(e) } : {}),
        templates: { hasReady: async () => over.ready ?? true },
        baselineRequests: { markStarted: async (_o, _e, sha) => void baselineStarted.push(sha) },
        clock,
        ...(over.maps ? { maps: over.maps } : over.map ? { maps: { newest: async () => over.map, record: async () => ({ stored: true }) } } : {}),
        ...(over.publisher ? { publisher: { started: async (c) => void published.push(`started:${c.mode}`), finished: async (_c, r, s) => void (published.push(`finished:${r.status}:${s.cwd}`), 'state' in r && finishedStates.push(r.state)), cancelled: async () => void published.push('cancelled') } } : {}),
    };
    return { service: new SuiteService(deps), finishedStates, clockNow: () => clock.now(), cell, runs, baselines, demand, tokens, baselineStarted, published };
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

    it('given a deadline (a suite inside a Run) it stops there: a spec still running is not_run and the run ends neutral', async () => {
        const w = world({ specs: { 'cypress/e2e/a.cy.ts': { ms: 60_000 }, 'cypress/e2e/b.cy.ts': { ms: 90 * 60_000 } } });
        const deadlineAt = new Date(w.clockNow() + 12 * 60_000).toISOString();
        const out = await w.service.run(request(), passthrough, { deadlineAt });
        expect(out).toMatchObject({ status: 'ran', state: 'neutral' });
        expect(w.clockNow()).toBeLessThanOrEqual(Date.parse(deadlineAt) + 2 * 60_000);
    });

    it('a cancelled suite closes its check cancelled inside its own step (the workflow runs no step after a cancel) and the run ends cancelled', async () => {
        const w = world({ publisher: true });
        const stop = new AbortController();
        stop.abort();
        const out = await w.service.run(request(), passthrough, { cancellationSignal: () => stop.signal });
        expect(out).toMatchObject({ status: 'ran', state: 'cancelled' });
        expect((await w.runs.get(ORG, 'sr-1'))?.state).toBe('cancelled');
        expect(w.finishedStates).toContain('cancelled');
        expect(w.cell.claims.size).toBe(w.cell.released.length);
    });

    it('a workflow cancelled after its check opened closes the check too, and the cancel goes on up', async () => {
        const w = world({ publisher: true });
        const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
            if (name === 'suite:run') throw cancelError();
            return fn();
        };
        await expect(w.service.run(request(), step)).rejects.toMatchObject({ name: 'DBOSWorkflowCancelledError' });
        expect(w.published).toEqual(['started:ci', 'cancelled']);
    });

    it('judges a PR against the drift the product counted: the run stores how many main commits were past the merge base', async () => {
        const MERGE_BASE = 'c'.repeat(40);
        const w = world();
        await w.service.run(request({ mergeBase: MERGE_BASE, mainBehind: 6 }), passthrough);
        expect((await w.runs.get(ORG, 'sr-1'))?.baseDrift).toBe(6);
        // With no count the worker only knows the merge base is not main: at least one.
        const w2 = world();
        await w2.service.run(request({ mergeBase: MERGE_BASE }), passthrough);
        expect((await w2.runs.get(ORG, 'sr-1'))?.baseDrift).toBe(1);
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

    it('keeps the artifacts of a failed spec as evidence and records them on its result, the recipe naming the directory', async () => {
        const evidence = new InMemoryEvidenceStore();
        const shot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
        const w = world({ evidence, recipe: `${RECIPE}  results:\n    artifacts: ["cypress/screenshots"]\n`, specs: { 'cypress/e2e/a.cy.ts': { pr: [{ fail: 'boom' }] }, 'cypress/e2e/b.cy.ts': {} }, shots: { 'cypress/screenshots/cypress/e2e/a.cy.ts/fail.png': shot } });
        await w.service.run(request(), passthrough);
        expect([...evidence.objects.values()]).toEqual([{ body: shot, contentType: 'image/png' }]);
        const row = (await w.runs.results(ORG, 'sr-1')).find((r) => r.spec === 'cypress/e2e/a.cy.ts' && r.phase === 'shard');
        expect(row?.artifacts).toMatchObject([{ name: 'cypress/screenshots/cypress/e2e/a.cy.ts/fail.png', contentType: 'image/png', bytes: shot.length }]);
    });

    describe('which specs run (docs section 6.1)', () => {
        const recipe = parseRecipe(RECIPE);
        const digest = suiteDigestOf(suiteConfigOf((recipe as { recipe: Parameters<typeof suiteConfigOf>[0] }).recipe)!.config, ['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']);
        const mapOf = (specs: Record<string, string[]>, over: { mainSha?: string; suiteDigest?: string; finishedAt?: Date } = {}) => ({ mainSha: MAIN, suiteDigest: digest, finishedAt: new Date('2026-11-23T11:00:00.000Z'), specs, ...over });

        it('runs the whole suite and keeps on the run why: there is no coverage map yet', async () => {
            const w = world();
            await w.service.run(request({ changedFiles: ['apps/dashboard/src/x.ts'] }), passthrough);
            expect(w.cell.starts.flatMap((s) => s.specs).sort()).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']);
            expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_missing', total: 2 });
        });

        it('a baseline is the whole suite on main, whatever the map says', async () => {
            const w = world({ map: mapOf({ 'cypress/e2e/a.cy.ts': ['x.ts'] }) });
            await w.service.run(request({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined, changedFiles: ['x.ts'] }), passthrough);
            expect(w.cell.starts.flatMap((s) => s.specs).sort()).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']);
            expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'baseline', total: 2 });
        });

        it('with a map, runs only the specs the change reaches, and says how many of how many', async () => {
            const w = world({ map: mapOf({ 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] }) });
            await w.service.run(request({ changedFiles: ['src/x.ts'] }), passthrough);
            expect(w.cell.starts.flatMap((s) => s.specs)).toEqual(['cypress/e2e/a.cy.ts']);
            expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'selected', selected: 1, total: 2, reachedBy: { 'src/x.ts': ['cypress/e2e/a.cy.ts'] } });
        });

        it('a change that reaches no spec ends the run green without a shard host, and says none ran', async () => {
            const w = world({ recipe: `${RECIPE}  ignore: ["docs/**"]\n`, map: mapOf({ 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] }) });
            const out = await w.service.run(request({ changedFiles: ['docs/a.md'] }), passthrough);
            expect(out).toMatchObject({ status: 'ran', state: 'passed' });
            expect(w.cell.starts).toEqual([]);
            expect((await w.runs.get(ORG, 'sr-1'))).toMatchObject({ state: 'passed', selection: { mode: 'none', total: 2 } });
        });

        it('a re-push of the PR runs what was red before plus what the new commits reach, and runs the red spec first', async () => {
            const w = world({ map: mapOf({ 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] }) });
            await w.runs.create({ suiteRunId: 'sr-0', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'ci', prNumber: 7, prSha: 'c'.repeat(40), mergeBase: MAIN, mainSha: MAIN, requestedAt: new Date('2026-11-23T11:00:00.000Z'), selection: { mode: 'selected', selected: 1, total: 2 } });
            await w.runs.finish(ORG, 'sr-0', 'failed', new Date('2026-11-23T11:20:00.000Z'), { classification: { tests: [{ spec: 'cypress/e2e/b.cy.ts', title: 't', class: 'regression', blocks: true, finding: true, baseDrift: 0 }], massFailure: false, requestTemplateBuild: false } });
            await w.service.run(request({ changedFiles: ['src/x.ts', 'src/y.ts'], deltaFiles: ['src/x.ts'] }), passthrough);
            expect(w.cell.starts[0].specs).toEqual(['cypress/e2e/b.cy.ts', 'cypress/e2e/a.cy.ts']);
            expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'selected', selected: 2, total: 2 });
        });

        it('a map of another commit than the one the run is judged on, or older than three days, is stale: the whole suite, with the reason', async () => {
            const specs = { 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] };
            const other = world({ map: mapOf(specs, { mainSha: 'd'.repeat(40) }) });
            await other.service.run(request({ changedFiles: ['src/x.ts'] }), passthrough);
            expect((await other.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_stale', total: 2 });
            const old = world({ map: mapOf(specs, { finishedAt: new Date('2026-11-19T12:00:00.000Z') }) });
            await old.service.run(request({ changedFiles: ['src/x.ts'] }), passthrough);
            expect((await old.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_stale', total: 2 });
        });

        it('a spec list that changed gives another digest: the map of the old list is not reused', async () => {
            const w = world({ main: ['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts', 'cypress/e2e/c.cy.ts'], map: mapOf({ 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] }) });
            await w.service.run(request({ changedFiles: ['src/x.ts'] }), passthrough);
            expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_digest', total: 3 });
            expect(w.cell.starts.flatMap((s) => s.specs)).toHaveLength(3);
        });

        describe('a regression while main is ahead of the merge base (section 9.3)', () => {
            const MERGE_BASE = 'c'.repeat(40);
            // Five specs, so that one red spec is no mass failure (more than 25% would be).
            const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `cypress/e2e/${n}.cy.ts`);
            const five = suiteDigestOf(suiteConfigOf((recipe as { recipe: Parameters<typeof suiteConfigOf>[0] }).recipe)!.config, names);
            const covers = { 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'], 'cypress/e2e/c.cy.ts': ['src/z.ts'], 'cypress/e2e/d.cy.ts': ['src/w.ts'], 'cypress/e2e/e.cy.ts': ['src/v.ts'] };
            const specs = { 'cypress/e2e/a.cy.ts': { pr: [{ fail: 'boom' as const }] } };
            const ahead = (over: Partial<RuntimeSuiteRequested> = {}) => request({ mergeBase: MERGE_BASE, mainBehind: 4, changedFiles: ['src/x.ts', 'src/y.ts', 'src/z.ts', 'src/w.ts', 'src/v.ts'], ...over });
            const world5 = (over: Parameters<typeof world>[0] = {}) => world({ main: names, specs, ...over });
            const classes = async (w: ReturnType<typeof world>) => (await w.runs.get(ORG, 'sr-1'))?.classification?.tests.map((t) => t.class);

            it('is a regression and fails the run when the coverage map says the diff reaches the spec', async () => {
                const w = world5({ map: mapOf(covers, { suiteDigest: five }) });
                const out = await w.service.run(ahead(), passthrough);
                expect(await classes(w)).toEqual(['regression']);
                expect(out).toMatchObject({ status: 'ran', state: 'failed' });
            });

            it('stays unconfirmed when the map says the diff does not reach the spec (a retry runs the whole suite on the same diff)', async () => {
                const w = world5({ map: mapOf(covers, { suiteDigest: five }) });
                const out = await w.service.run(ahead({ changedFiles: ['src/y.ts'], specs: names }), passthrough);
                expect(await classes(w)).toEqual(['regression_unconfirmed']);
                expect(out).not.toMatchObject({ state: 'failed' });
            });

            it('with no map it stays unconfirmed, and the run keeps the structured reason for the check', async () => {
                const w = world5();
                const out = await w.service.run(ahead(), passthrough);
                expect(await classes(w)).toEqual(['regression_unconfirmed']);
                expect(out).not.toMatchObject({ state: 'failed' });
                expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_missing', total: 5, reachUnknown: 'map_missing' });
            });

            it('a spec the PR changed itself is reached even with no map; a lockfile reaches every spec', async () => {
                const own = world5();
                await own.service.run(ahead({ changedFiles: ['apps/dashboard/cypress/e2e/a.cy.ts'] }), passthrough);
                expect(await classes(own)).toEqual(['regression']);
                const lock = world5();
                await lock.service.run(ahead({ changedFiles: ['pnpm-lock.yaml'] }), passthrough);
                expect(await classes(lock)).toEqual(['regression']);
                expect((await lock.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'lockfile', total: 5 });
            });

            it('when main is not ahead the reason is not stored: nothing waits for the branch to update', async () => {
                const w = world5();
                await w.service.run(request({ changedFiles: ['src/x.ts'] }), passthrough);
                expect((await w.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'full', reason: 'map_missing', total: 5 });
            });
        });

        it('a baseline collects coverage into the map store, and the next PR run selects by that map', async () => {
            const maps = new InMemorySuiteCoverageMaps();
            const covers = { 'cypress/e2e/a.cy.ts': { covers: ['src/x.ts'] }, 'cypress/e2e/b.cy.ts': { covers: ['src/y.ts'] } };
            const base = world({ maps, specs: covers });
            await base.service.run(request({ suiteRunId: 'sr-b', key: 'sr-b', mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), passthrough);
            expect(base.cell.starts.map((x) => x.specs.length)).toEqual([1, 1]);
            expect((await maps.newest(ORG, ENV))?.specs).toEqual({ 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'] });
            const pr = world({ maps, specs: covers });
            await pr.service.run(request({ changedFiles: ['src/y.ts'] }), passthrough);
            expect(pr.cell.starts.flatMap((x) => x.specs)).toEqual(['cypress/e2e/b.cy.ts']);
            expect(pr.cell.starts.some((x) => 'NODE_V8_COVERAGE' in x.env)).toBe(false);
            expect((await pr.runs.get(ORG, 'sr-1'))?.selection).toEqual({ mode: 'selected', selected: 1, total: 2, reachedBy: { 'src/y.ts': ['cypress/e2e/b.cy.ts'] } });
        });

        it('does not take itself for the previous run when a crashed step runs again', async () => {
            const w = world();
            await w.service.run(request(), passthrough);
            await w.runs.finish(ORG, 'sr-1', 'failed', new Date(), {});
            // A replay of the step finds the run it created: a finished one is answered, never planned against itself.
            expect(await w.service.run(request(), passthrough)).toMatchObject({ replayed: true });
        });
    });
});

// docs/runtime/e2e-suites.md section 6.1 (Proof b) and D14, build-plan step 19: the shadow check of selection.
describe('the shadow check of selection', () => {
    const recipe = parseRecipe(RECIPE);
    const names = ['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts', 'cypress/e2e/c.cy.ts', 'cypress/e2e/d.cy.ts', 'cypress/e2e/e.cy.ts'];
    const digest = suiteDigestOf(suiteConfigOf((recipe as { recipe: Parameters<typeof suiteConfigOf>[0] }).recipe)!.config, names);
    const map = { mainSha: MAIN, suiteDigest: digest, finishedAt: new Date('2026-11-23T11:00:00.000Z'), specs: { 'cypress/e2e/a.cy.ts': ['src/x.ts'], 'cypress/e2e/b.cy.ts': ['src/y.ts'], 'cypress/e2e/c.cy.ts': ['src/z.ts'], 'cypress/e2e/d.cy.ts': ['src/d.ts'], 'cypress/e2e/e.cy.ts': ['src/e.ts'] } };
    const plain = Object.fromEntries(names.map((n) => [n, {}]));
    const kit = () => ({ shadows: new InMemorySuiteShadows(), selection: new InMemorySuiteSelectionState(), alerts: [] as unknown[] });
    const pr = (n: number, over: Partial<RuntimeSuiteRequested> = {}) => request({ suiteRunId: `sr-${n}`, key: `sr-${n}`, prNumber: n, changedFiles: ['src/x.ts'], ...over });
    const w = (shadow: ReturnType<typeof kit>, over: Parameters<typeof world>[0] = {}) => world({ main: names, map, shadow, ...over });
    const shadowOf = (n: number, over: Partial<RuntimeSuiteRequested> = {}) => request({ suiteRunId: `sh-${n}`, key: `sh-${n}`, mode: 'shadow', prNumber: n, changedFiles: ['src/x.ts'], ...over });

    it('every 5th selected run of an environment also enqueues a full background run, with the specs it ran and the files the PR changed', async () => {
        const shadow = kit();
        for (let n = 1; n <= 4; n++) await w(shadow).service.run(pr(n), passthrough);
        expect(shadow.shadows.rows.size).toBe(0);
        await w(shadow).service.run(pr(5), passthrough);
        expect([...shadow.shadows.rows.values()]).toEqual([expect.objectContaining({ organizationId: ORG, environmentId: ENV, sourceRunId: 'sr-5', prNumber: 5, prSha: PR, mergeBase: MAIN, mainSha: MAIN, state: 'queued', selected: ['cypress/e2e/a.cy.ts'], changedFiles: ['src/x.ts'] })]);
    });

    it('counts only runs that were selected: the whole suite, a retry and a baseline never count', async () => {
        const shadow = kit();
        // Five whole-suite runs (the safety net: a lockfile changed) and five retries.
        for (let n = 1; n <= 5; n++) await w(shadow).service.run(pr(n, { changedFiles: ['pnpm-lock.yaml'] }), passthrough);
        for (let n = 6; n <= 10; n++) await w(shadow).service.run(pr(n, { specs: ['cypress/e2e/a.cy.ts'] }), passthrough);
        expect(shadow.shadows.rows.size).toBe(0);
        expect(shadow.selection.rows.get(ENV)?.selected ?? 0).toBe(0);
    });

    it('the shadow is the whole suite in the background: never published, whatever it finds, and it is no earlier run of the PR', async () => {
        const shadow = kit();
        const x = w(shadow, { publisher: true, specs: { ...plain, 'cypress/e2e/b.cy.ts': { pr: [{ fail: 'boom' }] } } });
        const out = await x.service.run(shadowOf(1), passthrough);
        expect(out).toMatchObject({ status: 'ran', state: 'failed' });
        expect(x.published).toEqual([]);
        expect([...x.cell.starts[0].specs].sort()).toEqual(names);
        expect((await x.runs.get(ORG, 'sh-1'))?.selection).toEqual({ mode: 'full', reason: 'shadow', total: 5 });
        expect(await x.runs.latestForPr(ORG, ENV, 1)).toBeNull();
    });

    describe('what a shadow finds', () => {
        const broken = { ...plain, 'cypress/e2e/b.cy.ts': { pr: [{ fail: 'boom' as const }] } };
        const queue = async (shadow: ReturnType<typeof kit>, n: number, selected = ['cypress/e2e/a.cy.ts']) => {
            await shadow.shadows.request({ shadowRunId: `sh-${n}`, organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', sourceRunId: `sr-${n}`, prNumber: n, prSha: PR, mergeBase: MAIN, mainSha: MAIN, selected, changedFiles: ['src/x.ts'], removedFiles: [] });
        };

        it('a spec the selection skipped and the full run fails is a selection miss, stored with the changed files; the environment runs the whole suite for the next 10 PRs and an alert is raised', async () => {
            const shadow = kit();
            await queue(shadow, 1);
            await w(shadow, { specs: broken }).service.run(shadowOf(1), passthrough);
            expect(await shadow.shadows.get(ORG, 'sh-1')).toMatchObject({ state: 'done', misses: ['cypress/e2e/b.cy.ts'], conclusive: true, changedFiles: ['src/x.ts'] });
            expect(await shadow.selection.read(ORG, ENV)).toEqual({ off: false, fullPrsLeft: 10 });
            expect(shadow.alerts).toEqual([expect.objectContaining({ type: 'selection_miss', environmentId: ENV, specs: ['cypress/e2e/b.cy.ts'], off: false })]);
            // The next pull request runs the whole suite, with the reason; the window counts it once, however often it is pushed.
            const next = w(shadow, { specs: broken });
            await next.service.run(pr(2), passthrough);
            expect((await next.runs.get(ORG, 'sr-2'))?.selection).toEqual({ mode: 'full', reason: 'selection_miss', total: 5 });
            expect((await shadow.selection.read(ORG, ENV)).fullPrsLeft).toBe(9);
            const again = w(shadow, { specs: broken });
            await again.runs.create({ suiteRunId: 'sr-2', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'ci', prNumber: 2, prSha: 'c'.repeat(40), mergeBase: MAIN, mainSha: MAIN, requestedAt: new Date('2026-11-23T11:00:00.000Z'), selection: { mode: 'full', reason: 'selection_miss', total: 5 } });
            await again.runs.finish(ORG, 'sr-2', 'passed', new Date('2026-11-23T11:20:00.000Z'));
            await again.service.run(pr(2, { suiteRunId: 'sr-2b', key: 'sr-2b' }), passthrough);
            expect((await again.runs.get(ORG, 'sr-2b'))?.selection).toMatchObject({ mode: 'full', reason: 'selection_miss' });
            expect((await shadow.selection.read(ORG, ENV)).fullPrsLeft).toBe(9);
        });

        it('two misses in ten shadows turn selection off for the environment until a person turns it on: every PR then runs the whole suite', async () => {
            const shadow = kit();
            await queue(shadow, 1);
            await queue(shadow, 2);
            await w(shadow, { specs: broken }).service.run(shadowOf(1), passthrough);
            expect((await shadow.selection.read(ORG, ENV)).off).toBe(false);
            await w(shadow, { specs: broken }).service.run(shadowOf(2), passthrough);
            expect((await shadow.selection.read(ORG, ENV)).off).toBe(true);
            expect(shadow.alerts.map((a) => (a as { type: string; off: boolean }).off)).toEqual([false, true]);
            const next = w(shadow);
            await next.service.run(pr(3), passthrough);
            expect((await next.runs.get(ORG, 'sr-3'))?.selection).toEqual({ mode: 'full', reason: 'selection_off', total: 5 });
            await shadow.selection.reenable(ORG, ENV);
            const back = w(shadow);
            await back.service.run(pr(4), passthrough);
            expect((await back.runs.get(ORG, 'sr-4'))?.selection).toMatchObject({ mode: 'selected' });
        });

        it('noise is no miss: a flaky spec, one red on main too, and a spec the selection did run', async () => {
            const shadow = kit();
            await queue(shadow, 1, ['cypress/e2e/a.cy.ts']);
            const specs = { ...plain, 'cypress/e2e/a.cy.ts': { pr: [{ fail: 'boom' as const }] }, 'cypress/e2e/b.cy.ts': { pr: [{ fail: 'x' as const }, 'pass' as const] }, 'cypress/e2e/c.cy.ts': { pr: [{ fail: 'old' as const }], main: [{ fail: 'old' as const }] } };
            await w(shadow, { specs }).service.run(shadowOf(1), passthrough);
            expect(await shadow.shadows.get(ORG, 'sh-1')).toMatchObject({ state: 'done', misses: [], conclusive: true });
            expect(await shadow.selection.read(ORG, ENV)).toEqual({ off: false, fullPrsLeft: 0 });
            expect(shadow.alerts).toEqual([]);
        });

        it('a shadow that could not run is no evidence: it is completed inconclusive and the brake stays where it was', async () => {
            const shadow = kit();
            await queue(shadow, 1);
            await w(shadow, { ready: false }).service.run(shadowOf(1), passthrough);
            expect(await shadow.shadows.get(ORG, 'sh-1')).toMatchObject({ state: 'done', misses: [], conclusive: false });
            expect(await shadow.selection.read(ORG, ENV)).toEqual({ off: false, fullPrsLeft: 0 });
        });

        it('a shadow asked again after it finished changes nothing: the brake is applied once', async () => {
            const shadow = kit();
            await queue(shadow, 1);
            const x = w(shadow, { specs: broken });
            await x.service.run(shadowOf(1), passthrough);
            await shadow.selection.consumeFullPr(ORG, ENV);
            await x.service.run(shadowOf(1), passthrough);
            expect((await shadow.selection.read(ORG, ENV)).fullPrsLeft).toBe(9);
            expect(shadow.alerts).toHaveLength(1);
        });
    });
});
