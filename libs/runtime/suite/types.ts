// The result model of docs/runtime/e2e-suites.md section 7, as the parsers
// produce it: what a runner wrote about one spec file. The engine adds the
// shard, the host and the artifacts when it stores a result.

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'pending';
export type SpecStatus = 'passed' | 'failed' | 'skipped';

export interface TestAttempt {
    status: 'passed' | 'failed' | 'skipped';
    ms: number;
    error?: string;
}

export interface TestResult {
    /** The full title, as the reporter gives it; with the spec it identifies a test. */
    title: string;
    status: TestStatus;
    /** Every try inside the run, in order; the last one decides `status`. */
    attempts: TestAttempt[];
}

export interface SpecResult {
    /** The spec file, as the runner reported it (relative to the suite's cwd when the runner says so). */
    spec: string;
    tests: TestResult[];
    status: SpecStatus;
    durationMs: number;
    /** The first failing test's error as a signature (error-signature.ts); absent on a spec that did not fail. */
    errorSignature?: string;
}

/** A test that failed and then passed inside its own run (a runner-level retry). */
export const isFlakyInRun = (t: TestResult): boolean => t.status === 'passed' && t.attempts.some((a) => a.status === 'failed');

/** One spec file's result from its tests; the spec fails when any test failed. */
export function specResultOf(spec: string, tests: TestResult[], signatureOf: (error: string | undefined) => string): SpecResult {
    const failed = tests.find((t) => t.status === 'failed');
    const ran = tests.some((t) => t.status === 'passed');
    const durationMs = tests.reduce((n, t) => n + t.attempts.reduce((m, a) => m + a.ms, 0), 0);
    const status: SpecStatus = failed ? 'failed' : ran ? 'passed' : 'skipped';
    if (!failed) return { spec, tests, status, durationMs };
    const error = [...failed.attempts].reverse().find((a) => a.status === 'failed')?.error;
    const errorSignature = signatureOf(error);
    return { spec, tests, status, durationMs, ...(errorSignature ? { errorSignature } : {}) };
}
