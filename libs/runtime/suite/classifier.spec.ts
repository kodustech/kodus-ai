import {
    type BaselineEvidence,
    classifyFailures,
    type ClassifyInput,
    needsMainRerun,
    planReruns,
    type Rerun,
    RERUN_BUDGET,
    type SuiteFailure,
    testKey,
} from './classifier';

const fail = (spec: string, title = 't', over: Partial<SuiteFailure> = {}): SuiteFailure => ({ spec, title, kind: 'test', timedOut: false, errorSignature: 'AssertionError: boom', ...over });
const passed: Rerun = { result: 'passed' };
const failed = (errorSignature = 'AssertionError: boom', timedOut = false): Rerun => ({ result: 'failed', errorSignature, timedOut });
const rerunsOf = (f: SuiteFailure, r: Rerun) => ({ [testKey(f.spec, f.title)]: r });

// One failing test with the re-runs a row of section 9.3 names.
function classifyOne(over: { first?: Partial<SuiteFailure>; pr?: Rerun; main?: ClassifyInput['main']; baseDrift?: number; reached?: boolean; baseline?: BaselineEvidence }) {
    const f = fail('a.cy.ts', 't', over.first);
    const plan = planReruns({ specsRun: 100, failures: [f] });
    const [c] = classifyFailures({
        failures: [f],
        plan,
        prRerun: over.pr ? rerunsOf(f, over.pr) : {},
        infraRerun: {},
        main: over.main ?? { state: 'ran', results: {} },
        baseDrift: over.baseDrift ?? 0,
        diffReachedSpecs: over.reached === false ? [] : ['a.cy.ts'],
        baseline: over.baseline,
        notRunSpecs: [],
    }).tests;
    return c;
}
const mainRan = (r: Rerun): ClassifyInput['main'] => ({ state: 'ran', results: rerunsOf(fail('a.cy.ts'), r) });

describe('planReruns (9.4)', () => {
    it('re-runs the failed specs, one entry per spec however many tests failed', () => {
        const p = planReruns({ specsRun: 100, failures: [fail('a', 'x'), fail('a', 'y'), fail('b')] });
        expect(p).toMatchObject({ massFailure: false, rerunSpecs: ['a', 'b'], overBudgetSpecs: [], infraRetrySpecs: [] });
    });
    it('caps the re-runs at 40 specs and names the rest as over budget', () => {
        const failures = Array.from({ length: 60 }, (_, i) => fail(`s${String(i).padStart(2, '0')}`));
        const p = planReruns({ specsRun: 1000, failures });
        expect(RERUN_BUDGET).toBe(40);
        expect(p.rerunSpecs).toHaveLength(40);
        expect(p.overBudgetSpecs).toHaveLength(20);
        expect(p.rerunSpecs[0]).toBe('s00');
    });
    it('is a mass failure when more than 25% of the specs failed, and starts no re-run', () => {
        const failures = Array.from({ length: 26 }, (_, i) => fail(`s${i}`));
        const p = planReruns({ specsRun: 100, failures });
        expect(p.massFailure).toBe(true);
        expect(p.rerunSpecs).toEqual([]);
        expect(p.infraRetrySpecs).toEqual([]);
    });
    // kr-mono on dev: 14 specs that also fail on main and 2 real regressions were 16 of 39 failed, a mass failure, so the
    // regressions were never re-run nor reported. What the baseline already shows failing on main is not this PR's mass.
    it('does not count the specs a usable baseline shows failing on main toward a mass failure', () => {
        const onMain = Array.from({ length: 14 }, (_, i) => `old${i}`);
        const failures = [...onMain.map((s) => fail(s)), fail('orders-list'), fail('orders-filters')];
        const p = planReruns({ specsRun: 39, failures, failingOnMain: new Set(onMain) });
        expect(p.massFailure).toBe(false);
        expect(p.rerunSpecs).toEqual(expect.arrayContaining(['orders-list', 'orders-filters']));
        // Without the baseline the same failures are a mass failure, as before.
        expect(planReruns({ specsRun: 39, failures }).massFailure).toBe(true);
    });
    it('is not a mass failure at exactly 25%', () => {
        const failures = Array.from({ length: 25 }, (_, i) => fail(`s${i}`));
        expect(planReruns({ specsRun: 100, failures }).massFailure).toBe(false);
    });
    it('sends a spec whose failure is infra to one retry on a fresh host, not to the rules', () => {
        const p = planReruns({ specsRun: 100, failures: [fail('a', 't', { kind: 'infra' })] });
        expect(p).toMatchObject({ rerunSpecs: [], infraRetrySpecs: ['a'] });
    });
});

describe('classifyFailures, section 9.3 rows', () => {
    it('failed, PR passed on re-run: flaky, blocks nothing', () => {
        expect(classifyOne({ pr: passed, main: mainRan(failed()) })).toMatchObject({ class: 'flaky', blocks: false, finding: false });
    });
    it('failed, PR failed, main passed: regression, blocks and is a finding', () => {
        expect(classifyOne({ pr: failed(), main: mainRan(passed) })).toMatchObject({ class: 'regression', blocks: true, finding: true });
    });
    it('failed, PR failed, main failed with the same signature: pre_existing', () => {
        expect(classifyOne({ pr: failed('E: x'), main: mainRan(failed('E: x')) })).toMatchObject({ class: 'pre_existing', blocks: false, finding: false });
    });
    it('failed, PR failed, main failed with another signature: pre_existing_changed, kept for a human, blocks nothing', () => {
        const c = classifyOne({ pr: failed('E: x'), main: mainRan(failed('E: y')) });
        expect(c).toMatchObject({ class: 'pre_existing_changed', blocks: false, finding: false });
        expect(c.mainSignature).toBe('E: y');
        expect(c.prSignature).toBe('E: x');
    });
    it('compares main with the PR re-run, not with the first pass', () => {
        expect(classifyOne({ first: { errorSignature: 'E: a' }, pr: failed('E: b'), main: mainRan(failed('E: b')) }).class).toBe('pre_existing');
    });
    it('a timeout on both sides is pre_existing whatever the signatures say', () => {
        expect(classifyOne({ pr: failed('E: t1', true), main: mainRan(failed('E: t2', true)) }).class).toBe('pre_existing');
    });
    it('a timeout on one side only goes by the signatures', () => {
        expect(classifyOne({ pr: failed('E: t1', true), main: mainRan(failed('E: t2', false)) }).class).toBe('pre_existing_changed');
    });
    it('an infra failure in the first pass is infra when the fresh-host retry passes', () => {
        const f = fail('a.cy.ts', 't', { kind: 'infra' });
        const plan = planReruns({ specsRun: 100, failures: [f] });
        const [c] = classifyFailures({ failures: [f], plan, prRerun: {}, infraRerun: rerunsOf(f, passed), main: { state: 'ran', results: {} }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: [] }).tests;
        expect(c).toMatchObject({ class: 'infra', blocks: false, finding: false });
    });
    it('an infra failure that is infra again on the fresh host is unclassified/infra, never a regression', () => {
        const f = fail('a.cy.ts', 't', { kind: 'infra' });
        const plan = planReruns({ specsRun: 100, failures: [f] });
        const [c] = classifyFailures({ failures: [f], plan, prRerun: {}, infraRerun: rerunsOf(f, { result: 'infra' }), main: { state: 'ran', results: {} }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: [] }).tests;
        expect(c).toMatchObject({ class: 'unclassified', reason: 'infra', blocks: false, finding: false });
    });
    it('a PR re-run that dies as infra is unclassified/infra', () => {
        expect(classifyOne({ pr: { result: 'infra' }, main: mainRan(passed) })).toMatchObject({ class: 'unclassified', reason: 'infra' });
    });
});

describe('classifyFailures, caps and mass failures (9.4)', () => {
    it('a spec over the re-run budget is unclassified/budget', () => {
        const failures = Array.from({ length: 41 }, (_, i) => fail(`s${String(i).padStart(2, '0')}`));
        const plan = planReruns({ specsRun: 1000, failures });
        const out = classifyFailures({ failures, plan, prRerun: {}, infraRerun: {}, main: { state: 'ran', results: {} }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: [] });
        const last = out.tests.find((t) => t.spec === 's40')!;
        expect(last).toMatchObject({ class: 'unclassified', reason: 'budget', blocks: false });
    });
    it('every failure of a mass failure is unclassified/mass_failure and the run says so', () => {
        const failures = Array.from({ length: 30 }, (_, i) => fail(`s${i}`));
        const plan = planReruns({ specsRun: 100, failures });
        const out = classifyFailures({ failures, plan, prRerun: {}, infraRerun: {}, main: { state: 'ran', results: {} }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: [] });
        expect(out.massFailure).toBe(true);
        expect(out.tests.every((t) => t.class === 'unclassified' && t.reason === 'mass_failure' && !t.blocks && !t.finding)).toBe(true);
    });
    it('a re-run that did not finish inside the re-run cap is unclassified/timeout', () => {
        expect(classifyOne({ pr: { result: 'not_run' }, main: mainRan(passed) })).toMatchObject({ class: 'unclassified', reason: 'timeout' });
        expect(classifyOne({ pr: failed(), main: mainRan({ result: 'not_run' }) })).toMatchObject({ class: 'unclassified', reason: 'timeout' });
    });
    it('a spec the shard never ran, still unfinished after one re-queue, is unclassified/not_run', () => {
        const out = classifyFailures({ failures: [], plan: planReruns({ specsRun: 10, failures: [] }), prRerun: {}, infraRerun: {}, main: { state: 'ran', results: {} }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: ['late.cy.ts'] });
        expect(out.tests).toEqual([expect.objectContaining({ spec: 'late.cy.ts', class: 'unclassified', reason: 'not_run', blocks: false })]);
    });
});

describe('classifyFailures, base drift (8.2, D2)', () => {
    it('a pass on main that is ahead of the merge base is regression when the diff reaches the spec', () => {
        expect(classifyOne({ pr: failed(), main: mainRan(passed), baseDrift: 4, reached: true })).toMatchObject({ class: 'regression', finding: true, baseDrift: 4 });
    });
    it('a pass on main that is ahead of the merge base is regression_unconfirmed, not a finding, when the diff does not reach the spec', () => {
        expect(classifyOne({ pr: failed(), main: mainRan(passed), baseDrift: 4, reached: false })).toMatchObject({ class: 'regression_unconfirmed', blocks: false, finding: false, baseDrift: 4 });
    });
    it('no drift: reach is not asked, a pass on main is a regression', () => {
        expect(classifyOne({ pr: failed(), main: mainRan(passed), baseDrift: 0, reached: false }).class).toBe('regression');
    });
});

describe('classifyFailures, missing, stale or unavailable main (9.5)', () => {
    const base = (over: Partial<BaselineEvidence> = {}): BaselineEvidence => ({
        sha: 'abc',
        exactMergeBase: true,
        commitsBehindMain: 3,
        digestMatches: true,
        specs: { 'a.cy.ts': { status: 'passed' } },
        ...over,
    });
    const noHost = { state: 'no_host' } as const;

    it('template missing: failed twice on the PR, failed_unconfirmed, and a template build is asked for', () => {
        const f = fail('a.cy.ts');
        const out = classifyFailures({ failures: [f], plan: planReruns({ specsRun: 100, failures: [f] }), prRerun: rerunsOf(f, failed()), infraRerun: {}, main: { state: 'template_missing' }, baseDrift: 0, diffReachedSpecs: [], notRunSpecs: [] });
        expect(out.tests[0]).toMatchObject({ class: 'failed_unconfirmed', blocks: false, finding: false });
        expect(out.requestTemplateBuild).toBe(true);
    });
    it('no main host and the exact baseline passed the spec: regression_probable, not a finding', () => {
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base() })).toMatchObject({ class: 'regression_probable', blocks: false, finding: false });
    });
    it('no main host and the exact baseline failed the spec: pre_existing', () => {
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base({ specs: { 'a.cy.ts': { status: 'failed', errorSignature: 'E: z' } } }) }).class).toBe('pre_existing');
    });
    it('no main host and no baseline: failed_unconfirmed', () => {
        expect(classifyOne({ pr: failed(), main: noHost }).class).toBe('failed_unconfirmed');
    });
    it('no main host and a baseline that is not the merge base: failed_unconfirmed', () => {
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base({ exactMergeBase: false }) }).class).toBe('failed_unconfirmed');
    });
    it('a stale baseline (older than 20 commits, or another suite digest) is not evidence', () => {
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base({ commitsBehindMain: 21 }) }).class).toBe('failed_unconfirmed');
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base({ digestMatches: false }) }).class).toBe('failed_unconfirmed');
    });
    it('a main re-run that came back as infra uses the baseline like a missing host', () => {
        expect(classifyOne({ pr: failed(), main: mainRan({ result: 'infra' }), baseline: base() }).class).toBe('regression_probable');
    });
    it('no baseline for the spec itself is no evidence', () => {
        expect(classifyOne({ pr: failed(), main: noHost, baseline: base({ specs: {} }) }).class).toBe('failed_unconfirmed');
    });
});

describe('needsMainRerun (8.2): a red-everywhere spec skips the main run', () => {
    const baseline: BaselineEvidence = { sha: 'abc', exactMergeBase: true, commitsBehindMain: 1, digestMatches: true, specs: { 'a.cy.ts': { status: 'failed', errorSignature: 'E: x' } } };
    it('does not when the exact baseline failed with the same signature as both PR attempts', () => {
        expect(needsMainRerun(fail('a.cy.ts', 't', { errorSignature: 'E: x' }), failed('E: x'), baseline)).toBe(false);
    });
    it('does when the signature differs, there is no baseline, or it is stale', () => {
        expect(needsMainRerun(fail('a.cy.ts', 't', { errorSignature: 'E: x' }), failed('E: y'), baseline)).toBe(true);
        expect(needsMainRerun(fail('a.cy.ts', 't', { errorSignature: 'E: x' }), failed('E: x'), undefined)).toBe(true);
        expect(needsMainRerun(fail('a.cy.ts', 't', { errorSignature: 'E: x' }), failed('E: x'), { ...baseline, commitsBehindMain: 30 })).toBe(true);
    });
    it('does when the baseline passed the spec', () => {
        expect(needsMainRerun(fail('a.cy.ts', 't', { errorSignature: 'E: x' }), failed('E: x'), { ...baseline, specs: { 'a.cy.ts': { status: 'passed' } } })).toBe(true);
    });
});
