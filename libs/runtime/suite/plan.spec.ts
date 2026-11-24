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
