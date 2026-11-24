import { createHash } from 'crypto';

// The digest of a suite (docs/runtime/e2e-suites.md section 7.1): the suite block and the spec file list. A baseline,
// a coverage map and a stored plan are only valid for the digest they were made with, so a changed command, glob or
// spec list never reuses an old one. Pure; the order of the specs and of the env entries does not matter, and neither
// does anything that does not change what runs (timeouts, the shard ceiling).

export interface DigestedSuite {
    runner: string;
    command: string;
    cwd?: string;
    env: Readonly<Record<string, string>>;
    resultsGlob: string;
}

export function suiteDigestOf(suite: DigestedSuite, specs: readonly string[]): string {
    const canonical = JSON.stringify({
        runner: suite.runner,
        command: suite.command,
        cwd: suite.cwd ?? '.',
        resultsGlob: suite.resultsGlob,
        env: Object.entries(suite.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        specs: [...specs].sort(),
    });
    return createHash('sha256').update(canonical).digest('hex');
}
