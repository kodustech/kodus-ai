import picomatch from 'picomatch';

import { SUITE_UNRUNNABLE_SIGNATURE } from '@libs/runtime/blockers/catalog';
import type { EnvironmentRuntime, EnvError, StepResult } from '@libs/runtime/environment';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import type { EnvironmentSetupBlocker } from '@libs/runtime/run';

import { runDetached } from '../suite/detached-exec';
import { suiteConfigOf } from '../suite/suite-config';
import { fillSpecs, infraCause } from '../suite/suite-engine';
import { blockerMessage } from './blocker-message';

/** The most one check runs the suite's spec for: a spec that runs longer ran, which is all the check asks. */
export const SUITE_CHECK_TIMEOUT_MS = 6 * 60_000;
/** Less time than this left on the claim: the check does not start (no verdict either way). */
export const SUITE_CHECK_MIN_MS = 90_000;
const LIST_TIMEOUT_MS = 60_000;
const SAFE_DIR = /^[A-Za-z0-9_.\/@+-]{1,256}$/;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const answered = (r: StepResult | EnvError): r is StepResult => 'transport' in r && r.transport === 'ok';
/** The runner's lines worth reading in a failure: the error, the missing file, the refused host. */
const TELLING = /error|missing|not found|no such|cannot|can't|failed|denied|refused|invalid|ENOENT/i;

export type SuiteCheck =
    | { state: 'skipped'; detail: string }
    | { state: 'done'; detail: string }
    | { state: 'failed'; blocker: Omit<EnvironmentSetupBlocker, 'at'> };

export interface SuiteCheckInput {
    /** The claim's commands; the caller names the steps as its hub takes them (suiteStepId for the hub). */
    env: Pick<EnvironmentRuntime, 'exec'>;
    claimId: string;
    /** The boot's key: names the check's state directory and its steps. */
    key: string;
    /** The recipe the setup booted (its text); a recipe with no suite block is not checked. */
    recipe: string | null | undefined;
    /** The most the check may take: what is left of the claim before the bake needs it. */
    budgetMs: number;
    now(): number;
    sleep(ms: number): Promise<void>;
}

/**
 * The recipe's suite, run on one of its specs in the service it names, on the setup's claim (the default branch, after the
 * ready check), so a recipe whose app boots but whose suite cannot run is the recipe's failure in the setup, where Kody's
 * author gets it back with the runner's own words, instead of every spec of every Run being infra (kr-mono on dev: the
 * suite's image held no spec, and the runner said only that its support file was missing).
 *
 * Failed: no spec under the suite's glob in that service, or a runner that left no result file. A spec that ran red is
 * still a suite that runs, and a timeout, a cell that cannot exec in a service or a lost transport say nothing about the
 * recipe: those are skipped, never a verdict.
 */
export async function checkSuite(i: SuiteCheckInput): Promise<SuiteCheck> {
    const parsed = i.recipe ? parseRecipe(i.recipe) : undefined;
    const suite = parsed?.ok ? suiteConfigOf(parsed.recipe) : undefined;
    if (!suite) return { state: 'skipped', detail: 'the recipe declares no suite' };
    if (i.budgetMs < SUITE_CHECK_MIN_MS) return { state: 'skipped', detail: 'too little of the machine left to run a spec' };
    const { config, specsGlob } = suite;
    const where = config.service ? `service ${config.service}` : 'the public service';
    const root = picomatch.scan(specsGlob).base || '.';
    if (!SAFE_DIR.test(root)) return { state: 'skipped', detail: `the spec glob ${specsGlob} cannot be listed` };
    const env = i.env;
    const fail = (lines: string[]): SuiteCheck => ({ state: 'failed', blocker: { kind: 'toolchain', signature: SUITE_UNRUNNABLE_SIGNATURE, message: blockerMessage(lines.filter(Boolean).join('\n')) } });

    const listed = await env.exec(i.claimId, {
        stepId: `${i.key}:suite-list`,
        command: `find ${quote(root)} -type f -not -path '*/node_modules/*'`,
        ...(config.service ? { service: config.service } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        timeoutMs: LIST_TIMEOUT_MS,
    });
    if ('code' in listed && listed.code === 'exec_service_unavailable') return { state: 'skipped', detail: 'this cell cannot run a command in a named service' };
    if (!answered(listed)) return { state: 'skipped', detail: 'the cell did not answer the listing' };
    const isSpec = picomatch(specsGlob, { dot: true });
    const specs = listed.stdout
        .split('\n')
        .map((l) => l.trim().replace(/^\.\//, ''))
        .filter((p) => p && isSpec(p))
        .sort();
    if (listed.exitCode !== 0 || specs.length === 0) {
        return fail([
            `${where} holds no file matching suite.specs (${specsGlob}) under ${config.cwd ?? 'its working directory'}: find ${root} exited ${listed.exitCode}`,
            ...lastLines(listed.stderr || listed.stdout, 4),
        ]);
    }

    const spec = specs[0];
    const out = await runDetached({
        env,
        claimId: i.claimId,
        ...(config.service ? { service: config.service } : {}),
        key: `${i.key.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}-suite-check`,
        command: fillSpecs(config, [spec]),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        envVars: config.env,
        resultsGlob: config.resultsGlob,
        timeoutMs: Math.min(SUITE_CHECK_TIMEOUT_MS, i.budgetMs),
        now: i.now,
        sleep: i.sleep,
    });
    if (out.outcome === 'infra') {
        // A runner that started and left nothing is the recipe's; a cell that could not be asked is no verdict on it.
        if (out.reason !== 'no_result_file' && out.reason !== 'start_failed') return { state: 'skipped', detail: `the check could not run the suite (${out.reason})` };
        return fail([
            `suite.command on ${spec} in ${where} left no result file matching suite.results (${config.resultsGlob}): ${infraCause(out.reason, out.exitCode, out.logTail)}`,
            ...tellingLines(out.logTail ?? ''),
        ]);
    }
    if (out.outcome === 'timeout' || out.outcome === 'cancelled') return { state: 'skipped', detail: `${spec} did not finish within the check (${out.outcome})` };
    return { state: 'done', detail: `${spec} ran in ${where} (${out.resultFiles.length} result file${out.resultFiles.length === 1 ? '' : 's'})` };
}

const lastLines = (text: string, n: number) =>
    text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-n);

/** The runner's lines that say why, else its last ones: what the author reads first. */
function tellingLines(log: string): string[] {
    // eslint-disable-next-line no-control-regex
    const lines = lastLines(log.replace(/\x1B\[[0-9;]*m/g, ''), 60);
    const telling = lines.filter((l) => TELLING.test(l));
    return (telling.length ? telling : lines).slice(-8);
}
