import type { SuiteReport } from '@libs/runtime/suite';

import { KODY_RUNTIME_E2E_CHECK_NAME, renderSuiteCheckOutput, suiteCheckNameOf } from './render-suite-check';

const base: SuiteReport = {
    state: 'passed',
    mode: 'ci',
    mainSha: 'a'.repeat(40),
    prSha: 'b'.repeat(40),
    selection: { mode: 'full', reason: 'map_missing', total: 12 },
    totals: { passed: 12, failed: 0, skipped: 0, notRun: 0 },
    classes: { regression: 0, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 },
    durationMs: 11 * 60_000,
    annotations: [],
    annotationsOmitted: 0,
    requestedAt: '2026-11-23T12:00:00.000Z',
};
const report = (over: Partial<SuiteReport> = {}): SuiteReport => ({ ...base, ...over });

describe('the name of the suite check', () => {
    it('is its own, beside the Run check: one per environment the PR runs in', () => {
        expect(KODY_RUNTIME_E2E_CHECK_NAME).toBe('Kody Runtime e2e');
        expect(suiteCheckNameOf({ key: '' })).toBe('Kody Runtime e2e');
        expect(suiteCheckNameOf({ key: 'abc', name: 'demo-shop' })).toBe('Kody Runtime e2e (demo-shop)');
    });
});

describe('the suite check output', () => {
    it('a green run says what passed, how the specs were chosen and how long it took', () => {
        const out = renderSuiteCheckOutput(report(), {});
        expect(out.conclusion).toBe('success');
        expect(out.title).toBe('No regressions · 12 specs passed');
        expect(out.summary).toContain('| Passed | 12 |');
        expect(out.summary).toContain('Ran the whole suite: no coverage map is stored for this environment yet.');
        expect(out.summary).toContain('11 min');
    });

    it('a regression fails and leads the title; the table lists the classes the author needs', () => {
        const out = renderSuiteCheckOutput(report({ state: 'failed', totals: { passed: 10, failed: 2, skipped: 0, notRun: 0 }, classes: { regression: 1, preExisting: 1, flaky: 2, unclassified: 0, infra: 0 } }), {});
        expect(out.conclusion).toBe('failure');
        expect(out.title).toBe('1 regression · 10 specs passed');
        for (const row of ['| Regression | 1 |', '| Pre-existing | 1 |', '| Flaky | 2 |']) expect(out.summary).toContain(row);
        // Flaky and pre-existing are in the table, never the reason the check failed.
        expect(out.summary).toContain('Pre-existing and flaky failures do not fail this check.');
    });

    it('unclassified failures are neutral and say they are not proven to be the PR', () => {
        const out = renderSuiteCheckOutput(report({ state: 'neutral', classes: { regression: 0, preExisting: 0, flaky: 0, unclassified: 3, infra: 0 } }), {});
        expect(out.conclusion).toBe('neutral');
        expect(out.title).toBe('3 failures not classified');
        expect(out.summary).toContain('| Unclassified | 3 |');
    });

    // The suite runs from the setup file Kody wrote before anyone commits it: the check says so and where to review it.
    it("says when the suite ran from the setup file Kody wrote, which the repository does not have yet", () => {
        const out = renderSuiteCheckOutput(report({ source: 'environment' }), { settings: 'https://app.example/runtime/environments/env-1' });
        expect(out.summary).toContain('the setup file Kody wrote from your CI, not in your repository yet. [Review it and add it](https://app.example/runtime/environments/env-1)');
        expect(renderSuiteCheckOutput(report(), {}).summary).not.toContain('Suite settings');
    });

    it('says the baseline it compared with and how far main moved, with the hint to update the branch', () => {
        const out = renderSuiteCheckOutput(report({ baseline: { sha: 'c'.repeat(40) }, baseDrift: 4 }), {});
        expect(out.summary).toContain('Baseline: `ccccccc`');
        expect(out.summary).toContain('main has moved 4 commits since this branch started: update the branch to confirm.');
    });

    it('while main is ahead and the specs the change reaches are unknown, says why a failure cannot be confirmed, from the structured reason', () => {
        const sel = { mode: 'full' as const, reason: 'map_stale' as const, total: 40, reachUnknown: 'map_stale' as const };
        const out = renderSuiteCheckOutput(report({ baseDrift: 4, selection: sel }), {});
        expect(out.summary).toContain('Which specs this change reaches is not known (the stored coverage map is too old to trust), so a failing spec cannot be confirmed as a regression until the branch is up to date.');
        expect(renderSuiteCheckOutput(report({ selection: sel }), {}).summary).not.toContain('Which specs this change reaches');
    });

    it('names a selection of specs and the one reason a whole run was chosen, as sentences the product wrote', () => {
        expect(renderSuiteCheckOutput(report({ selection: { mode: 'selected', selected: 6, total: 40 } }), {}).summary).toContain('Ran 6 of 40 specs the change can reach.');
        expect(renderSuiteCheckOutput(report({ selection: { mode: 'full', reason: 'lockfile', total: 40 } }), {}).summary).toContain('Ran the whole suite: a lockfile changed.');
        expect(renderSuiteCheckOutput(report({ selection: { mode: 'none', total: 40 } }), {}).summary).toContain('No spec is reached by this change: none ran.');
    });

    it('a run that could not start says why, never a green', () => {
        const out = renderSuiteCheckOutput(report({ state: 'neutral', unavailable: 'template_missing', totals: { passed: 0, failed: 0, skipped: 0, notRun: 0 } }), {});
        expect(out.conclusion).toBe('neutral');
        expect(out.title).toBe('Could not run');
        expect(out.summary).toContain('There is no ready environment template yet');
    });

    it('timed out and cancelled map to their own conclusions', () => {
        expect(renderSuiteCheckOutput(report({ state: 'timed_out' }), {}).conclusion).toBe('timed_out');
        expect(renderSuiteCheckOutput(report({ state: 'cancelled' }), {}).conclusion).toBe('cancelled');
    });

    it('says how many annotations it does not show', () => {
        const out = renderSuiteCheckOutput(report({ state: 'failed', classes: { regression: 230, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 }, annotationsOmitted: 30 }), {});
        expect(out.summary).toContain('30 more failures are not annotated.');
    });

    it('links to the Run when there is one, and to nothing when the suite has no page of its own yet', () => {
        expect(renderSuiteCheckOutput(report({ mode: 'run' }), { run: 'https://app.example.test/runtime/runs/r1' }).summary).toContain('[Open the Run](https://app.example.test/runtime/runs/r1)');
        expect(renderSuiteCheckOutput(report(), {}).summary).not.toContain('](');
    });

    it('while the suite runs, is in progress and has no conclusion', () => {
        const out = renderSuiteCheckOutput(report({ state: 'running', totals: { passed: 0, failed: 0, skipped: 0, notRun: 0 } }), {});
        expect(out.conclusion).toBeUndefined();
        expect(out.title).toBe('Running');
    });
});
