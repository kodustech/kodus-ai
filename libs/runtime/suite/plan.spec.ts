import type { CoverageMapInput } from './select';
import { planSuiteRun, type SuitePlanInput } from './plan';

// docs/runtime/e2e-suites.md section 6.1 on the request path: which specs a run executes. The coverage map is a later step of
// the plan, so today there is none and every plan is the whole suite with the reason `map_missing`; with a map the same
// code selects, re-pushes and orders. Never fewer specs than the safety net allows, and unknown is never "nothing".

const ALL = ['a.cy.ts', 'b.cy.ts', 'c.cy.ts'];
const map = (specs: Record<string, string[]>): CoverageMapInput => ({ suiteDigest: 'd', commitsBehindMain: 0, ageMs: 0, specs });
const input = (over: Partial<SuitePlanInput> = {}): SuitePlanInput => ({ allSpecs: ALL, suiteDigest: 'd', mergeBase: 'm'.repeat(40), prSha: 'p'.repeat(40), changed: ['src/x.ts'], ...over });

describe('with no coverage map (today)', () => {
    it('runs the whole suite and says the map is missing, whatever the PR changed', () => {
        for (const changed of [['src/x.ts'], ['docs/readme.md'], [], undefined]) {
            const p = planSuiteRun(input({ changed }));
            expect(p.specs).toEqual(ALL);
            expect(p.selection).toEqual({ mode: 'full', reason: 'map_missing', total: 3 });
            expect(p.failedBefore).toEqual([]);
        }
    });

    it('keeps the more specific reason of the safety net when a file alone says it (a lockfile changes everything)', () => {
        expect(planSuiteRun(input({ changed: ['pnpm-lock.yaml'] })).selection).toEqual({ mode: 'full', reason: 'lockfile', total: 3 });
    });

    it('a re-push of a PR is the whole suite too: the delta cannot be read without a map', () => {
        const p = planSuiteRun(input({ previous: { prSha: 'q'.repeat(40), mergeBase: 'm'.repeat(40), mode: 'full', green: true, failures: [] }, deltaFiles: ['src/y.ts'] }));
        expect(p.specs).toEqual(ALL);
        expect(p.selection.mode).toBe('full');
    });

    it('an ignored-only or empty change still runs everything: with no map nothing proves a spec can be skipped', () => {
        expect(planSuiteRun(input({ changed: ['docs/a.md'], ignore: ['docs/**'] })).specs).toEqual(ALL);
    });
});

describe('with a coverage map', () => {
    const m = map({ 'a.cy.ts': ['src/x.ts'], 'b.cy.ts': ['src/y.ts'], 'c.cy.ts': ['src/z.ts'] });

    it('selects the specs the change reaches, and says how many of how many', () => {
        const p = planSuiteRun(input({ map: m }));
        expect(p.specs).toEqual(['a.cy.ts']);
        expect(p.selection).toEqual({ mode: 'selected', selected: 1, total: 3 });
        expect(p.diffCoverage).toEqual({ 'a.cy.ts': 1 });
    });

    it('runs nothing, and says so, when the change reaches no spec', () => {
        const p = planSuiteRun(input({ map: m, changed: ['docs/a.md'], ignore: ['docs/**'] }));
        expect(p.specs).toEqual([]);
        expect(p.selection).toEqual({ mode: 'none', total: 3 });
    });

    it('treats a change it cannot read as unknown: the whole suite, never none', () => {
        const p = planSuiteRun(input({ map: m, changed: undefined }));
        expect(p.specs).toEqual(ALL);
        expect(p.selection.mode).toBe('full');
    });

    it('a re-push runs what was red before plus what the new commits reach, and orders the red ones first', () => {
        const p = planSuiteRun(input({ map: m, previous: { prSha: 'q'.repeat(40), mergeBase: 'm'.repeat(40), mode: 'selected', green: false, failures: [{ spec: 'c.cy.ts', class: 'regression' }] }, deltaFiles: ['src/y.ts'] }));
        expect(p.specs).toEqual(['b.cy.ts', 'c.cy.ts']);
        expect(p.failedBefore).toEqual(['c.cy.ts']);
        expect(p.selection).toEqual({ mode: 'selected', selected: 2, total: 3 });
    });

    it('a rebase selects again from the new merge base', () => {
        const p = planSuiteRun(input({ map: m, previous: { prSha: 'q'.repeat(40), mergeBase: 'o'.repeat(40), mode: 'selected', green: true, failures: [] }, deltaFiles: ['src/y.ts'] }));
        expect(p.specs).toEqual(['a.cy.ts']);
    });
});

describe('the brake of the shadow check (D14)', () => {
    const m = map({ 'a.cy.ts': ['src/x.ts'], 'b.cy.ts': ['src/y.ts'], 'c.cy.ts': ['src/z.ts'] });
    const green = { prSha: 'q'.repeat(40), mergeBase: 'm'.repeat(40), mode: 'full' as const, green: true, failures: [] };

    it.each([['selection_miss' as const], ['selection_off' as const]])('%s runs the whole suite with that reason, whatever the map would select', (forceFull) => {
        const p = planSuiteRun(input({ map: m, forceFull }));
        expect(p.specs).toEqual(ALL);
        expect(p.selection).toEqual({ mode: 'full', reason: forceFull, total: 3 });
    });

    it('also for a re-push: a previous green full run with an empty delta runs none, but not while the brake is on', () => {
        const p = planSuiteRun(input({ map: m, previous: green, deltaFiles: [], forceFull: 'selection_miss' }));
        expect(p.specs).toEqual(ALL);
        expect(p.selection).toEqual({ mode: 'full', reason: 'selection_miss', total: 3 });
    });

    it('a shadow run is the whole suite with its own reason', () => {
        expect(planSuiteRun(input({ map: m, forceFull: 'shadow' })).selection).toEqual({ mode: 'full', reason: 'shadow', total: 3 });
    });
});

// Which specs the PR's diff reaches, for the classifier (section 9.3): while main is ahead of the merge base, a failing spec
// the diff does not reach is only `regression_unconfirmed`. Read from the same map and rules selection uses, never guessed.
describe('the specs the diff reaches (diff reach)', () => {
    const m = map({ 'a.cy.ts': ['src/x.ts'], 'b.cy.ts': ['src/y.ts'], 'c.cy.ts': ['src/z.ts'] });

    it('with a usable map, is what the diff selects by coverage, whatever the re-push delta says', () => {
        const p = planSuiteRun(input({ map: m, changed: ['src/x.ts', 'src/y.ts'], previous: { prSha: 'q'.repeat(40), mergeBase: 'm'.repeat(40), mode: 'selected', green: true, failures: [] }, deltaFiles: ['src/x.ts'] }));
        expect(p.reach).toEqual({ specs: ['a.cy.ts', 'b.cy.ts'] });
    });

    it('follows the importer walk and the workspace closure selection applies', () => {
        const importersOf = (f: string) => (f === 'src/deep.ts' ? ['src/y.ts'] : []);
        expect(planSuiteRun(input({ map: m, changed: ['src/deep.ts'], importersOf })).reach).toEqual({ specs: ['b.cy.ts'] });
        const workspaceSpecsOf = (f: string) => (f.startsWith('packages/ui/') ? ['c.cy.ts'] : []);
        expect(planSuiteRun(input({ map: m, changed: ['packages/ui/button.ts'], workspaceSpecsOf })).reach).toEqual({ specs: ['c.cy.ts'] });
    });

    it('a spec the PR adds or changes is always reached, even one the map has never seen or suite.ignore covers', () => {
        const p = planSuiteRun(input({ map: m, changed: ['src/x.ts', 'new.cy.ts'], allSpecs: [...ALL, 'new.cy.ts'] }));
        expect(p.reach).toEqual({ specs: ['a.cy.ts', 'new.cy.ts'] });
        const ignored = planSuiteRun(input({ map: m, changed: ['b.cy.ts'], ignore: ['*.cy.ts'] }));
        expect(ignored.reach).toEqual({ specs: ['b.cy.ts'] });
    });

    it.each(['package.json', 'pnpm-lock.yaml', 'cypress.config.ts', 'src/router/index.ts'])('%s says everything may be affected: every spec is reached, map or not', (file) => {
        expect(planSuiteRun(input({ map: m, changed: [file] })).reach).toEqual({ specs: ALL });
        expect(planSuiteRun(input({ changed: [file] })).reach).toEqual({ specs: ALL });
    });

    it('with no usable map the reach is unknown, and says why; only the specs the PR changed itself are reached', () => {
        expect(planSuiteRun(input({ changed: ['src/x.ts', 'a.cy.ts'] })).reach).toEqual({ specs: ['a.cy.ts'], unknown: 'map_missing' });
        expect(planSuiteRun(input({ map: { ...m, commitsBehindMain: 21 } })).reach).toEqual({ specs: [], unknown: 'map_stale' });
        expect(planSuiteRun(input({ map: { ...m, suiteDigest: 'other' } })).reach).toEqual({ specs: [], unknown: 'map_digest' });
        expect(planSuiteRun(input({ map: m, changed: undefined })).reach).toEqual({ specs: [], unknown: 'changes_unknown' });
    });

    it('a file no spec covers, or one most specs cover, proves nothing about the reach: unknown', () => {
        expect(planSuiteRun(input({ map: m, changed: ['src/nobody.ts'] })).reach).toEqual({ specs: [], unknown: 'uncovered_file' });
        const noisy = map({ 'a.cy.ts': ['src/n.ts'], 'b.cy.ts': ['src/n.ts'], 'c.cy.ts': ['src/z.ts'] });
        expect(planSuiteRun(input({ map: noisy, changed: ['src/n.ts'] })).reach).toEqual({ specs: [], unknown: 'noise_file' });
    });

    it('is computed under the brake too (the whole suite runs, the reach still reads the map)', () => {
        const p = planSuiteRun(input({ map: m, forceFull: 'selection_miss' }));
        expect(p.specs).toEqual(ALL);
        expect(p.reach).toEqual({ specs: ['a.cy.ts'] });
    });

    it('a shadow run has no diff to judge: no reach is claimed', () => {
        expect(planSuiteRun(input({ map: m, forceFull: 'shadow' })).reach).toBeUndefined();
    });
});
