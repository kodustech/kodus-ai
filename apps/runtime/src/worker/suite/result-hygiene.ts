import { redactPatterns } from '@libs/runtime/redaction';
import type { SpecResult, TestResult } from '@libs/runtime/suite';

import { type Canary, containsCanary, redactCanaries } from '../canary/canary';

// What a runner reports is the customer's code talking: a test title or a failure message can carry a secret the test
// printed, or the Run's canary. Every text of a result is redacted before it is stored, shown or published (the
// artifacts are, in suite-artifacts.ts), and a canary in it is a leak like one in an artifact. The sizes are bounded
// here too, so one result file cannot fill the results table or the suite view.

/** Tests kept per spec: every failed test, then the others in the runner's order up to this many in all. */
export const MAX_TESTS_PER_SPEC = 500;
/** A test title is a line of text, never a page. */
export const MAX_TITLE_CHARS = 500;
/** A runner's own retries of one test; the last ones decide the status, so the first are dropped. */
export const MAX_ATTEMPTS_PER_TEST = 10;

export interface CleanResult {
    result: SpecResult;
    /** A canary was in a title, an error or the error signature (it is redacted in `result`). */
    leaked: boolean;
}

export function cleanSpecResult(r: SpecResult, canaries: readonly Canary[]): CleanResult {
    const list = [...canaries];
    let leaked = false;
    const clean = (text: string): string => {
        if (list.length > 0 && containsCanary(text, list)) leaked = true;
        return redactCanaries(redactPatterns(text).text, list);
    };
    const kept = keptTests(r.tests);
    const tests: TestResult[] = kept.map((t) => ({
        title: clean(t.title).slice(0, MAX_TITLE_CHARS),
        status: t.status,
        attempts: t.attempts.slice(-MAX_ATTEMPTS_PER_TEST).map((a) => ({ status: a.status, ms: a.ms, ...(a.error !== undefined ? { error: clean(a.error) } : {}) })),
    }));
    const result: SpecResult = {
        spec: r.spec,
        status: r.status,
        durationMs: r.durationMs,
        tests,
        ...(r.errorSignature !== undefined ? { errorSignature: clean(r.errorSignature) } : {}),
    };
    return { result, leaked };
}

/** Every failed test stays (they are what the run is judged on); the rest fill the cap in the runner's order. */
function keptTests(tests: readonly TestResult[]): readonly TestResult[] {
    if (tests.length <= MAX_TESTS_PER_SPEC) return tests;
    const failed = new Set(tests.filter((t) => t.status === 'failed'));
    let room = Math.max(0, MAX_TESTS_PER_SPEC - failed.size);
    return tests.filter((t) => {
        if (failed.has(t)) return true;
        if (room === 0) return false;
        room--;
        return true;
    });
}
