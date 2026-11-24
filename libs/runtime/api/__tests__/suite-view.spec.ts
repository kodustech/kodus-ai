import type { Classification, ClassifiedTest } from '@libs/runtime/suite';

import type { StoredSuiteResultRecord, StoredSuiteRun } from '../domain/suite';
import { environmentSuiteView, runSuiteView, suiteUsageView } from '../domain/suite-view';

// docs/runtime/e2e-suites.md sections 10 and 13: the Run page's e2e suite tab, from what the Runtime stored. The product turns stored
// rows into structured fields (the web writes the sentences) and never invents what a row does not say.

const MAIN = 'a41c0d3'.padEnd(40, '0');
const HEAD = '7c2e9f1'.padEnd(40, '0');
const attempt = (status: 'passed' | 'failed', error?: string) => ({ status, ms: 1000, ...(error ? { error } : {}) });
const test = (title: string, status: 'passed' | 'failed', attempts = [attempt(status, status === 'failed' ? `boom in ${title}` : undefined)]) => ({ title, status, attempts });
const row = (phase: 'shard' | 'rerun_pr' | 'rerun_main', spec: string, tests: ReturnType<typeof test>[], over: Partial<StoredSuiteResultRecord> = {}): StoredSuiteResultRecord => ({
    phase,
    shard: 0,
    spec,
    status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
    durationMs: 60_000,
    tests,
    artifacts: [],
    ...over,
});
const classified = (spec: string, title: string, cls: ClassifiedTest['class'], over: Partial<ClassifiedTest> = {}): ClassifiedTest => ({ spec, title, class: cls, blocks: cls === 'regression', finding: cls === 'regression', baseDrift: 0, ...over });

function stored(over: { results?: StoredSuiteResultRecord[]; run?: Partial<StoredSuiteRun['run']>; shards?: StoredSuiteRun['shards'] } = {}): StoredSuiteRun {
    return {
        run: {
            suiteRunId: 'sr-1',
            organizationId: 'org-a',
            environmentId: 'env-1',
            repositoryId: 'repo-1',
            mode: 'run',
            state: 'failed',
            prNumber: 41,
            prSha: HEAD,
            mergeBase: MAIN,
            mainSha: MAIN,
            baselineSha: MAIN,
            baseDrift: 2,
            firstPassMs: 11 * 60_000,
            rerunMs: 3 * 60_000,
            selection: { mode: 'selected', selected: 4, total: 24, reachedBy: { 'src/routes/cart.js': ['checkout.spec.ts', 'cart.spec.ts'], 'src/lib/price.js': ['checkout.spec.ts', 'catalog.spec.ts'] } },
            requestedAt: '2026-11-24T10:00:00.000Z',
            finishedAt: '2026-11-24T10:06:12.000Z',
            ...over.run,
        },
        shards: over.shards ?? [
            { shard: 0, specs: ['checkout.spec.ts', 'cart.spec.ts'] },
            { shard: 1, specs: ['catalog.spec.ts', 'order.spec.ts'] },
        ],
        results:
            over.results ??
            [
                row('shard', 'checkout.spec.ts', [test('applies a discount code', 'failed')], { shard: 0 }),
                row('shard', 'cart.spec.ts', [test('adds an item', 'passed')], { shard: 0 }),
                row('shard', 'catalog.spec.ts', [test('lists products by price', 'failed')], { shard: 1, status: 'failed' }),
                row('shard', 'order.spec.ts', [test('shows the order confirmation', 'passed', [attempt('failed', 'timeout'), attempt('passed')])], { shard: 1 }),
                row('rerun_pr', 'checkout.spec.ts', [test('applies a discount code', 'failed')]),
                row('rerun_main', 'checkout.spec.ts', [test('applies a discount code', 'passed')]),
                row('rerun_pr', 'catalog.spec.ts', [test('lists products by price', 'failed')]),
                row('rerun_main', 'catalog.spec.ts', [test('lists products by price', 'failed')]),
            ],
    };
}
const withClassification = (s: StoredSuiteRun, classification: Classification): StoredSuiteRun => ({ ...s, run: { ...s.run, classification } });
const CLASSIFICATION: Classification = {
    massFailure: false,
    requestTemplateBuild: false,
    tests: [
        classified('catalog.spec.ts', 'lists products by price', 'pre_existing', { prSignature: 'S', mainSignature: 'S' }),
        classified('checkout.spec.ts', 'applies a discount code', 'regression', { prSignature: 'S1' }),
        classified('order.spec.ts', 'shows the order confirmation', 'flaky'),
    ],
};

describe('the Run page suite tab: what a run says', () => {
    const view = runSuiteView(withClassification(stored(), CLASSIFICATION));

    it('groups the red tests by whose fault they are, the regression first', () => {
        expect(view.failures.map((f) => [f.group, f.title])).toEqual([
            ['regression', 'applies a discount code'],
            ['pre_existing', 'lists products by price'],
            ['flaky', 'shows the order confirmation'],
        ]);
        expect(view.classes).toEqual({ regression: 1, preExisting: 1, flaky: 1, unclassified: 0 });
    });

    it('puts everything the re-runs could not settle under unclassified, keeping the classifier\'s own class and reason', () => {
        const v = runSuiteView(
            withClassification(stored(), {
                ...CLASSIFICATION,
                tests: [classified('checkout.spec.ts', 'applies a discount code', 'regression_unconfirmed'), classified('catalog.spec.ts', '', 'infra'), classified('order.spec.ts', '', 'unclassified', { reason: 'budget' })],
            }),
        );
        expect(v.failures.map((f) => [f.group, f.detail, f.reason])).toEqual([
            ['unclassified', 'regression_unconfirmed', undefined],
            ['unclassified', 'infra', undefined],
            ['unclassified', 'unclassified', 'budget'],
        ]);
        expect(v.classes.unclassified).toBe(3);
    });

    it('shows the error of the last failed attempt on the PR, the PR\'s tries, and what main said', () => {
        const regression = view.failures[0];
        expect(regression.error).toBe('boom in applies a discount code');
        // The first pass (one try) and the re-run (one try) both failed.
        expect(regression.pr).toEqual({ attempts: 2, failed: 2 });
        expect(regression.main).toEqual({ sha: MAIN, outcome: 'passed', sameError: false });
        const pre = view.failures[1];
        expect(pre.main).toEqual({ sha: MAIN, outcome: 'failed', sameError: true });
    });

    it('counts a runner retry that passed as a try: a test that failed and passed has a failed try among its attempts', () => {
        const flaky = view.failures[2];
        expect(flaky.pr).toEqual({ attempts: 2, failed: 1 });
        // Main was not run for it.
        expect(flaky.main).toBeUndefined();
    });

    it('says which changed files reach a spec, only from what the run stored', () => {
        expect(view.failures[0].reachedBy).toEqual(['src/lib/price.js', 'src/routes/cart.js']);
        const none = runSuiteView(withClassification(stored({ run: { selection: { mode: 'full', reason: 'lockfile', total: 24 } } }), CLASSIFICATION));
        expect(none.failures[0].reachedBy).toEqual([]);
        expect(none.selection).toEqual({ mode: 'full', reason: 'lockfile', total: 24 });
    });

    it('says how many specs ran of how many the suite has, the duration and the hosts', () => {
        expect(view.specs).toEqual({ ran: 4, total: 24 });
        expect(view.durationMs).toBe(6 * 60_000 + 12_000);
        expect(view.hosts).toBe(2);
        expect(view.mainSha).toBe(MAIN);
        expect(view.baseDrift).toBe(2);
    });

    it('reports the machine time of the first pass and of the re-runs apart, and nothing for a run that did not measure it', () => {
        expect(view.machine).toEqual({ firstPassMs: 660_000, rerunMs: 180_000 });
        const old = runSuiteView(withClassification(stored({ run: { firstPassMs: undefined, rerunMs: undefined } }), CLASSIFICATION));
        expect(old.machine).toBeUndefined();
    });

    it('lists the shards with their specs and how each ended, and the specs that passed', () => {
        expect(view.shards).toEqual([
            { shard: 0, specs: 2, passed: 1, failed: 1, notRun: 0, specMs: 120_000 },
            { shard: 1, specs: 2, passed: 1, failed: 1, notRun: 0, specMs: 120_000 },
        ]);
        expect(view.passed).toEqual(['cart.spec.ts', 'order.spec.ts']);
        expect(view.totals).toEqual({ passed: 2, failed: 2, skipped: 0, notRun: 0 });
    });

    it('offers "Re-run failed" once the run ended and left a red or unreported spec, never while it runs or when all passed', () => {
        expect(view.canRetry).toBe(true);
        expect(runSuiteView(stored({ run: { state: 'running', finishedAt: undefined } })).canRetry).toBe(false);
        const green = stored({ results: [row('shard', 'a.spec.ts', [test('ok', 'passed')])], run: { state: 'passed' } });
        expect(runSuiteView(green).canRetry).toBe(false);
        const lost = stored({ results: [row('shard', 'a.spec.ts', [], { status: 'infra' })], run: { state: 'neutral' } });
        expect(runSuiteView(lost).canRetry).toBe(true);
    });

    it('keeps the artifacts kept for a failed spec by name, never the evidence key', () => {
        const s = withClassification(
            stored({
                results: [
                    row('shard', 'checkout.spec.ts', [test('applies a discount code', 'failed')], { artifacts: [{ name: 'trace.zip', key: 'org-a/sr-1/pr/abc/suite-artifact', contentType: 'application/zip', bytes: 4096 }] }),
                ],
            }),
            { ...CLASSIFICATION, tests: [CLASSIFICATION.tests[1]] },
        );
        const v = runSuiteView(s);
        expect(v.failures[0].artifacts).toEqual([{ name: 'trace.zip', contentType: 'application/zip', bytes: 4096 }]);
        expect(JSON.stringify(v)).not.toContain('suite-artifact');
    });

    it('a run with no classification yet shows no failures, not a guess', () => {
        const running = runSuiteView(stored({ run: { state: 'running', finishedAt: undefined } }));
        expect(running.failures).toEqual([]);
        expect(running.durationMs).toBeUndefined();
    });

    it('cuts a long error to a bounded size', () => {
        const s = withClassification(stored({ results: [row('shard', 'checkout.spec.ts', [test('applies a discount code', 'failed', [attempt('failed', 'x'.repeat(5000))])])] }), { ...CLASSIFICATION, tests: [CLASSIFICATION.tests[1]] });
        expect(runSuiteView(s).failures[0].error!.length).toBeLessThanOrEqual(1000);
    });
});

describe('the environment settings: the e2e suite section', () => {
    const recipe = { runner: 'playwright', specs: 'e2e/**/*.spec.ts', command: 'npx playwright test {specs} --reporter=junit', results: { junit: 'results/*.xml' }, shards: 3, gate: 'default' as const, baseline: true };
    it('shows what the recipe declares, the last baseline and whether selection is on', () => {
        const v = environmentSuiteView({
            environmentId: 'env-1',
            recipe: { ...recipe, cwd: 'apps/web' },
            lastBaseline: { sha: MAIN, specs: 24, passed: 22, failed: 2, finishedAt: '2026-11-24T14:02:00.000Z' },
            selection: { off: false, fullPrsLeft: 0 },
            miss: null,
            ci: { setting: null, deployment: false },
        });
        expect(v.recipe).toEqual({ runner: 'playwright', specs: 'e2e/**/*.spec.ts', command: 'npx playwright test {specs} --reporter=junit', cwd: 'apps/web', results: 'results/*.xml', shards: 3, gate: 'default', baseline: true });
        expect(v.lastBaseline).toEqual({ sha: MAIN, specs: 24, passed: 22, failed: 2, finishedAt: '2026-11-24T14:02:00.000Z' });
        expect(v.selection).toEqual({ enabled: true });
        expect(v.ci).toEqual({ enabled: false, source: 'deployment' });
    });

    it('a person\'s off switch is the switch, and the shadow check\'s brake is a pause with its reason', () => {
        const person = environmentSuiteView({ environmentId: 'env-1', selection: { off: true, offBy: 'person', fullPrsLeft: 0 }, miss: null, ci: { setting: true, deployment: false } });
        expect(person.selection).toEqual({ enabled: false });
        expect(person.ci).toEqual({ enabled: true, source: 'environment' });
        const brake = environmentSuiteView({ environmentId: 'env-1', selection: { off: false, fullPrsLeft: 8 }, miss: { prNumber: 38, specs: ['e2e/search.spec.ts'] }, ci: { setting: false, deployment: true } });
        expect(brake.selection).toEqual({ enabled: true, brake: { off: false, fullPrsLeft: 8, miss: { prNumber: 38, specs: ['e2e/search.spec.ts'] } } });
        expect(brake.ci).toEqual({ enabled: false, source: 'environment' });
        const off = environmentSuiteView({ environmentId: 'env-1', selection: { off: true, offBy: 'brake', fullPrsLeft: 10 }, miss: null, ci: { setting: null, deployment: true } });
        expect(off.selection).toEqual({ enabled: true, brake: { off: true, fullPrsLeft: 10 } });
        expect(off.ci).toEqual({ enabled: true, source: 'deployment' });
    });

    it('has no recipe section when the recipe declares no suite', () => {
        expect(environmentSuiteView({ environmentId: 'env-1', selection: { off: false, fullPrsLeft: 0 }, miss: null, ci: { setting: null, deployment: false } }).recipe).toBeUndefined();
    });
});

describe('the usage report: the e2e suite lines', () => {
    const rows = [
        { mode: 'ci' as const, runs: 100, firstPassMs: 600 * 60_000, rerunMs: 0, withRerun: 0, unmeasured: 0 },
        { mode: 'run' as const, runs: 112, firstPassMs: 540 * 60_000, rerunMs: 150 * 60_000, withRerun: 64, unmeasured: 0 },
        { mode: 'baseline' as const, runs: 31, firstPassMs: 390 * 60_000, rerunMs: 0, withRerun: 0, unmeasured: 0 },
        { mode: 'shadow' as const, runs: 9, firstPassMs: 160 * 60_000, rerunMs: 0, withRerun: 0, unmeasured: 0 },
    ];
    it('is a line per kind: PR first passes (a Run and CI mode), baselines, re-runs and shadows, with runs and machine minutes', () => {
        const u = suiteUsageView({ rows, savings: null });
        expect(u.lines).toEqual([
            { kind: 'pr', runs: 212, minutes: 1140 },
            { kind: 'baseline', runs: 31, minutes: 390 },
            { kind: 'rerun', runs: 64, minutes: 150 },
            { kind: 'shadow', runs: 9, minutes: 160 },
        ]);
        expect(u.saved).toBeUndefined();
    });

    it('says minutes are unknown, not zero, when none of the runs measured them, and counts the unmeasured', () => {
        const u = suiteUsageView({ rows: [{ mode: 'ci', runs: 3, firstPassMs: 0, rerunMs: 0, withRerun: 0, unmeasured: 3 }], savings: null });
        expect(u.lines.find((l) => l.kind === 'pr')).toEqual({ kind: 'pr', runs: 3, minutes: null });
        expect(u.unmeasuredRuns).toBe(3);
    });

    it('reports savings only from the shadow pairs it could measure, with how many, and never a negative total', () => {
        expect(suiteUsageView({ rows, savings: { shadowedRuns: 9, savedMs: 520 * 60_000 } }).saved).toEqual({ minutes: 520, shadowedRuns: 9 });
        expect(suiteUsageView({ rows, savings: { shadowedRuns: 2, savedMs: -60_000 } }).saved).toBeUndefined();
        expect(suiteUsageView({ rows, savings: { shadowedRuns: 0, savedMs: 0 } }).saved).toBeUndefined();
    });

    it('has no lines at all for a month with no suite run', () => {
        expect(suiteUsageView({ rows: [], savings: null })).toEqual({ lines: [], unmeasuredRuns: 0 });
    });
});
