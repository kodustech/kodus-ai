import { baselineDue, BASELINE_CADENCE_DEFAULT_MS, mainOutcomeAt, mainSpecHistory, MAIN_HISTORY_RUNS, type MainObservation } from './main-history';
import { MAP_MAX_AGE_MS } from './select';
import { errorSignature } from './error-signature';

const obs = (mainSha: string, status: 'passed' | 'failed', observedAt: number, errorSignature?: string): MainObservation => ({ mainSha, status, observedAt, ...(errorSignature ? { errorSignature } : {}) });

describe('mainSpecHistory', () => {
    // A spec that gave a pass and a fail on the same main commit is flaky: the industry rule.
    it('is flaky when the same commit gave different outcomes', () => {
        expect(mainSpecHistory([obs('s1', 'passed', 1), obs('s1', 'failed', 2, 'boom')]).flaky).toBe(true);
    });

    // A spec that failed on one commit and passed on the next changed with the code: that is not flakiness.
    it('is not flaky when each commit gave one outcome, even if the outcomes differ across commits', () => {
        expect(mainSpecHistory([obs('s1', 'failed', 1, 'boom'), obs('s2', 'passed', 2)]).flaky).toBe(false);
    });

    // The counts are over the newest runs only, so an old failure ages out.
    it('counts only the newest runs', () => {
        const old = Array.from({ length: 5 }, (_, i) => obs(`old${i}`, 'failed', i, 'x'));
        const recent = Array.from({ length: MAIN_HISTORY_RUNS }, (_, i) => obs(`new${i}`, 'passed', 100 + i));
        expect(mainSpecHistory([...old, ...recent])).toMatchObject({ runs: MAIN_HISTORY_RUNS, passed: MAIN_HISTORY_RUNS, failed: 0 });
    });

    // The failure signatures main had are listed once each, for the classifier to compare a PR failure with.
    it('lists the failure signatures main had, once each', () => {
        const h = mainSpecHistory([obs('s1', 'failed', 1, 'Timed out <n>ms'), obs('s2', 'failed', 2, 'Timed out <n>ms'), obs('s3', 'failed', 3, 'no .cart'), obs('s4', 'passed', 4)]);
        expect(h.failureSignatures.sort()).toEqual(['Timed out <n>ms', 'no .cart']);
    });

    // No run, no claim: an empty history is not flaky and has nothing in it.
    it('is empty and not flaky with no run', () => {
        expect(mainSpecHistory([])).toEqual({ runs: 0, passed: 0, failed: 0, flaky: false, failureSignatures: [] });
    });

    // A stored signature goes back through the normalizer unchanged, so a stored main failure compares equal to the same failure of the PR.
    it('keeps a stored signature stable under the signature normalizer', () => {
        const sig = errorSignature('Timed out after 4000ms: no #radix-:r1a:-trigger at 0x7f3a9c1 (id 3f2504e0-4f89-41d3-9a0c-0305e82c3301)');
        expect(errorSignature(sig)).toBe(sig);
    });
});

describe('mainOutcomeAt', () => {
    // Runs that agree are a result a PR can reuse; runs that disagree on one commit are not evidence of either.
    it('says passed, failed, mixed or none from the runs of one commit', () => {
        expect(mainOutcomeAt([])).toBe('none');
        expect(mainOutcomeAt([{ status: 'passed' }, { status: 'passed' }])).toBe('passed');
        expect(mainOutcomeAt([{ status: 'failed' }])).toBe('failed');
        expect(mainOutcomeAt([{ status: 'passed' }, { status: 'failed' }])).toBe('mixed');
    });
});

describe('baselineDue', () => {
    const NOW = Date.parse('2026-11-27T12:00:00Z');
    const base = { now: NOW, suiteDigest: 'd1', cadenceMs: BASELINE_CADENCE_DEFAULT_MS, keepsMap: true, baseline: { suiteDigest: 'd1', finishedAt: NOW - 3_600_000 }, map: { suiteDigest: 'd1', finishedAt: NOW - 3_600_000 } };

    // Nothing was ever run on main: the first baseline is due.
    it('is due for the first baseline of an environment', () => {
        expect(baselineDue({ ...base, baseline: undefined })).toEqual({ due: true, reason: 'first' });
    });

    // The stored baseline is of another suite (a spec was added, the command changed): selection and the stored results are stale.
    it('is due when the suite digest changed under the stored baseline', () => {
        expect(baselineDue({ ...base, suiteDigest: 'd2' })).toEqual({ due: true, reason: 'digest_changed' });
    });

    // Selection reads the coverage map: missing, of another suite or past its age, it needs a full run to be refreshed.
    it('is due when the coverage map is missing, of another digest, or older than its limit', () => {
        expect(baselineDue({ ...base, map: undefined })).toEqual({ due: true, reason: 'map_missing' });
        expect(baselineDue({ ...base, map: { suiteDigest: 'd0', finishedAt: NOW } })).toEqual({ due: true, reason: 'map_digest' });
        expect(baselineDue({ ...base, map: { suiteDigest: 'd1', finishedAt: NOW - MAP_MAX_AGE_MS - 1 } })).toEqual({ due: true, reason: 'map_stale' });
    });

    // An environment that keeps no map is never asked for a baseline because of one.
    it('ignores the map when none is kept', () => {
        expect(baselineDue({ ...base, keepsMap: false, map: undefined })).toEqual({ due: false, reason: 'lazy' });
    });

    // However fresh everything is, main goes no longer than the cadence without a full run.
    it('is due when the cadence is over, and not a moment before', () => {
        const at = (ms: number) => baselineDue({ ...base, cadenceMs: 10_000, baseline: { suiteDigest: 'd1', finishedAt: NOW - ms }, map: { suiteDigest: 'd1', finishedAt: NOW } });
        expect(at(9_999)).toEqual({ due: false, reason: 'lazy' });
        expect(at(10_000)).toEqual({ due: true, reason: 'cadence' });
    });

    // The lazy case: same suite, fresh map, inside the cadence: main runs nothing for this commit.
    it('is not due when the suite, the map and the cadence are all fresh', () => {
        expect(baselineDue(base)).toEqual({ due: false, reason: 'lazy' });
    });
});
