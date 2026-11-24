import type { Classification, ClassifiedTest } from './classifier';
import { ANNOTATION_PAGE, buildSuiteReport, failingLineOf, pageAnnotations, suiteConclusionOf, type SuiteReportInput } from './report';

// docs/runtime/e2e-suites.md section 10.1: what the suite's check says. Pure: the run's stored state, its results and the
// classification in, the structured report the product renders out. Never a sentence of the Runtime's own.

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const test = (spec: string, cls: ClassifiedTest['class'], over: Partial<ClassifiedTest> = {}): ClassifiedTest => ({ spec, title: `${spec} works`, class: cls, blocks: cls === 'regression', finding: cls === 'regression', baseDrift: 0, ...over });
const classification = (...tests: ClassifiedTest[]): Classification => ({ tests, massFailure: false, requestTemplateBuild: false });
const row = (spec: string, status: string, error?: string, title = `${spec} works`) => ({
    phase: 'shard' as const,
    shard: 0,
    spec,
    status: status as never,
    durationMs: 10,
    tests: [{ title, status: status === 'failed' ? 'failed' : 'passed', attempts: [{ status: status === 'failed' ? 'failed' : 'passed', ms: 10, ...(error ? { error } : {}) }] }],
});
const input = (over: Partial<SuiteReportInput> = {}): SuiteReportInput => ({
    run: { state: 'passed', mode: 'ci', mainSha: A, prSha: B, mergeBase: A, requestedAt: '2026-11-23T12:00:00.000Z', finishedAt: '2026-11-23T12:20:00.000Z' },
    results: [],
    selection: { mode: 'full', reason: 'map_missing', total: 0 },
    ...over,
});

describe('the conclusion of the suite check', () => {
    it('follows D4: a regression fails, flaky and pre-existing never do, unclassified is neutral, and the run states carry through', () => {
        expect(suiteConclusionOf('failed')).toBe('failure');
        expect(suiteConclusionOf('passed')).toBe('success');
        expect(suiteConclusionOf('neutral')).toBe('neutral');
        expect(suiteConclusionOf('timed_out')).toBe('timed_out');
        expect(suiteConclusionOf('cancelled')).toBe('cancelled');
        // A run that errored never reads green: a check nobody can trust is neutral.
        expect(suiteConclusionOf('errored')).toBe('neutral');
        expect(suiteConclusionOf('running')).toBe('neutral');
    });
});

describe('the line a failing test points at', () => {
    it('is the line of the spec in the error stack, and none when the stack names another file', () => {
        expect(failingLineOf('AssertionError: expected 3\n    at Context.eval (cypress/e2e/a.cy.ts:42:11)\n    at node_modules/x.js:5:1', 'cypress/e2e/a.cy.ts')).toBe(42);
        expect(failingLineOf('Error\n    at http://localhost/__cypress/runner.js:900:3', 'cypress/e2e/a.cy.ts')).toBeUndefined();
        expect(failingLineOf(undefined, 'a.cy.ts')).toBeUndefined();
    });
});

describe('the report of a suite run', () => {
    it('counts the specs the first pass ended as and the red tests by class, and carries the selection reason', () => {
        const r = buildSuiteReport(
            input({
                run: { ...input().run, state: 'failed' },
                results: [row('a.cy.ts', 'passed'), row('b.cy.ts', 'failed', 'boom'), row('c.cy.ts', 'failed', 'boom'), row('d.cy.ts', 'skipped'), row('e.cy.ts', 'infra'), row('f.cy.ts', 'not_run')],
                classification: classification(test('b.cy.ts', 'regression'), test('c.cy.ts', 'flaky'), test('x.cy.ts', 'pre_existing'), test('y.cy.ts', 'pre_existing_changed'), test('z.cy.ts', 'failed_unconfirmed'), test('w.cy.ts', 'unclassified', { reason: 'budget' })),
                selection: { mode: 'selected', selected: 6, total: 40 },
            }),
        );
        expect(r.totals).toEqual({ passed: 1, failed: 2, skipped: 1, notRun: 2 });
        expect(r.classes).toEqual({ regression: 1, preExisting: 2, flaky: 1, unclassified: 2, infra: 0 });
        expect(r.selection).toEqual({ mode: 'selected', selected: 6, total: 40 });
        expect(r.state).toBe('failed');
        expect(r.durationMs).toBe(20 * 60_000);
    });

    it('says whether the whole suite ran, and why, when the selection fell back', () => {
        expect(buildSuiteReport(input()).selection).toEqual({ mode: 'full', reason: 'map_missing', total: 0 });
    });

    it('names the baseline it was judged against, and how far main moved even when no baseline was usable', () => {
        const with_ = buildSuiteReport(input({ baseline: { sha: A }, baseDrift: 3 }));
        expect(with_.baseline).toEqual({ sha: A });
        expect(with_.baseDrift).toBe(3);
        const none = buildSuiteReport(input({ baseDrift: 2 }));
        expect(none.baseline).toBeUndefined();
        expect(none.baseDrift).toBe(2);
        expect(buildSuiteReport(input()).baseDrift).toBeUndefined();
    });

    it('annotates each regression as a failure and each unclassified failure as a warning, never a flaky or a pre-existing one', () => {
        const r = buildSuiteReport(
            input({
                results: [row('a.cy.ts', 'failed', 'AssertionError: expected 3 got 4\n    at Context.eval (a.cy.ts:12:3)'), row('b.cy.ts', 'failed', 'timeout'), row('c.cy.ts', 'failed', 'x'), row('d.cy.ts', 'failed', 'y')],
                classification: classification(test('a.cy.ts', 'regression'), test('b.cy.ts', 'unclassified', { reason: 'mass_failure' }), test('c.cy.ts', 'flaky'), test('d.cy.ts', 'pre_existing')),
            }),
        );
        expect(r.annotations).toEqual([
            { path: 'a.cy.ts', line: 12, level: 'failure', title: 'a.cy.ts works', message: 'AssertionError: expected 3 got 4\n    at Context.eval (a.cy.ts:12:3)' },
            { path: 'b.cy.ts', line: 1, level: 'warning', title: 'b.cy.ts works', message: 'timeout' },
        ]);
    });

    it('puts the path the way the repository holds it, under the suite directory', () => {
        const r = buildSuiteReport(input({ cwd: 'apps/dashboard', results: [row('a.cy.ts', 'failed', 'boom')], classification: classification(test('a.cy.ts', 'regression')) }));
        expect(r.annotations[0].path).toBe('apps/dashboard/a.cy.ts');
    });

    it('cuts a message to 400 characters, a title to 255, and keeps at most 200 annotations, counting the rest', () => {
        const specs = Array.from({ length: 230 }, (_, i) => `s${i}.cy.ts`);
        const r = buildSuiteReport(input({ results: specs.map((s) => row(s, 'failed', 'e'.repeat(900), 't'.repeat(300))), classification: classification(...specs.map((s) => test(s, 'regression', { title: 't'.repeat(300) }))) }));
        expect(r.annotations).toHaveLength(200);
        expect(r.annotationsOmitted).toBe(30);
        expect(r.annotations[0].message).toHaveLength(400);
        expect(r.annotations[0].title).toHaveLength(255);
        expect(r.classes.regression).toBe(230);
    });

    it('a run that could not start says why and annotates nothing', () => {
        const r = buildSuiteReport(input({ run: { ...input().run, state: 'neutral' }, unavailable: 'template_missing' }));
        expect(r.unavailable).toBe('template_missing');
        expect(r.annotations).toEqual([]);
    });
});

describe('annotation pages', () => {
    it('GitHub takes at most 50 annotations a request: the rest go in follow-up updates of the same check', () => {
        expect(ANNOTATION_PAGE).toBe(50);
        const pages = pageAnnotations(Array.from({ length: 120 }, (_, i) => i));
        expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
        expect(pageAnnotations([])).toEqual([[]]);
    });
});
