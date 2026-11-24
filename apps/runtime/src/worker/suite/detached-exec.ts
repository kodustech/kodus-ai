import { createHash } from 'crypto';

import type { EnvError, EnvironmentRuntime, StepResult } from '@libs/runtime/environment';
import { EXEC_SERVICE_PATTERN } from '@libs/runtime/protocol/messages';

// A suite command run detached (docs/runtime/e2e-suites.md section 4, D3). `exec` caps `timeoutMs` at 600 s and a
// call returns 192 KiB, so a 10 to 25 minute runner does not fit one call. The shard driver starts the command in
// the claim with one short exec (a wrapper that backgrounds it and writes its exit status and log to a state
// directory), then polls with short execs: the state, the result files that exist, the tail of the log. No protocol
// change; a first-class exec.start and exec.poll is the better end state (D3) and would replace this file alone.
//
// Deterministic where it matters to a workflow: the clock and the sleeps are injected, and every call carries a
// step id derived from the key and the poll number, so a replay asks the cell the same questions.

/** The longest any one call of this file may ask for: far under the protocol's 600 s. */
export const POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_MS = 30_000;
/** Consecutive polls the transport may lose before the shard is infra. */
export const MAX_LOST_POLLS = 3;
const DEFAULT_STATE_DIR = '/tmp/kodus-suite';
const LOG_TAIL_BYTES = 2_048;

/** What the poll script prints on its first line (`state=...`); the fake environment of the specs prints the same. */
export const POLL_STATES = { running: 'running', exited: 'exited:', dead: 'dead' } as const;

export interface DetachedRunInput {
    /** Only `exec` of the environment runtime is used. */
    env: Pick<EnvironmentRuntime, 'exec'>;
    claimId: string;
    /** Names the run: the state directory and the step ids. Letters, digits, `.`, `_`, `-`. */
    key: string;
    command: string;
    /** Relative to the checkout; the command and the results glob both start there. */
    cwd?: string;
    /**
     * The compose service the command runs in (the recipe's `suite.service`): the start, every poll, the kill and the final
     * read all name it, so they all see the same container's files and process. Absent: the recipe's public service.
     */
    service?: string;
    /** Plain values the command runs with (the recipe's suite.env). */
    envVars?: Record<string, string>;
    /** Where the runner writes its result files, relative to `cwd` (`suite.results.junit`): a path pattern. */
    resultsGlob: string;
    /** The shard's cap: past it the command is stopped. */
    timeoutMs: number;
    pollMs?: number;
    stateDir?: string;
    now(): number;
    sleep(ms: number): Promise<void>;
    /** A cancel: aborted, the command and its children are stopped (as at the timeout) and what finished is named. Seen before the start and after each poll. */
    signal?: AbortSignal;
    /** Called after every answered poll with what exists now, so the engine can read results as they appear. */
    onPoll?(p: { resultFiles: string[]; logTail: string; elapsedMs: number }): void | Promise<void>;
}

export type InfraReason = 'no_result_file' | 'transport_lost' | 'start_failed' | 'bad_results_glob' | 'bad_input' | 'service_unsupported';

export type DetachedOutcome =
    /** The command exited on its own; red specs are results, so a non-zero status with result files is still this. */
    | { outcome: 'finished'; exitCode: number; resultFiles: string[]; logTail: string; durationMs: number }
    /** The process died with no exit status but left result files: the engine keeps them and re-runs the rest once. */
    | { outcome: 'crashed'; resultFiles: string[]; logTail: string; durationMs: number }
    /** The shard cap passed: the command was stopped; what finished is named. */
    | { outcome: 'timeout'; resultFiles: string[]; logTail: string; durationMs: number }
    /** The caller cancelled (`signal`): the command was stopped; what finished is named. */
    | { outcome: 'cancelled'; resultFiles: string[]; logTail: string; durationMs: number }
    /** Never a regression: the runner left no result file, or the cell could not be asked (the closed list of section 9.2). */
    | { outcome: 'infra'; reason: InfraReason; exitCode?: number; logTail?: string; durationMs: number };

const KEY = /^[A-Za-z0-9._-]{1,128}$/;
/** A path pattern: no shell syntax but `*` and `?`, relative, inside the directory it starts in. */
const SAFE_PATH = /^[A-Za-z0-9_.\/*?-]{1,256}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * A results glob that stays inside the directory it starts in: no absolute path, no `..`, and no segment that starts with a
 * dot and holds a wildcard (`.?` and `.*` expand to `..` in the shell).
 */
export const safeResultsGlob = (p: string): boolean =>
    SAFE_PATH.test(p) && !p.startsWith('/') && p.split('/').every((seg) => seg !== '..' && !(seg.startsWith('.') && /[*?]/.test(seg)));
const safePath = safeResultsGlob;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runDetached(i: DetachedRunInput): Promise<DetachedOutcome> {
    const t0 = i.now();
    const took = () => i.now() - t0;
    const infra = (reason: InfraReason, extra: { exitCode?: number; logTail?: string } = {}): DetachedOutcome => ({ outcome: 'infra', reason, ...extra, durationMs: took() });
    if (!safePath(i.resultsGlob)) return infra('bad_results_glob');
    const cwd = i.cwd ?? '.';
    if (i.service !== undefined && !EXEC_SERVICE_PATTERN.test(i.service)) return infra('bad_input');
    const where = i.service !== undefined ? { service: i.service } : {};
    if (!KEY.test(i.key) || !safePath(cwd) || Object.keys(i.envVars ?? {}).some((n) => !ENV_NAME.test(n))) return infra('bad_input');
    const dir = `${i.stateDir ?? DEFAULT_STATE_DIR}/${i.key}`;
    if (!/^[A-Za-z0-9._\/-]+$/.test(dir)) return infra('bad_input');

    if (i.signal?.aborted) return { outcome: 'cancelled', resultFiles: [], logTail: '', durationMs: took() };
    const started = await i.env.exec(i.claimId, { stepId: `${i.key}:start`, command: startScript(dir, cwd, i.command, i.envVars ?? {}), timeoutMs: POLL_TIMEOUT_MS, ...where });
    // A cell that cannot run in a named service ran nothing: the shard is infra with its own reason, never a failed spec.
    if ('code' in started && started.code === 'exec_service_unavailable') return infra('service_unsupported');
    if (!answered(started) || started.exitCode !== 0) return infra('start_failed');

    const deadline = t0 + i.timeoutMs;
    const pollMs = i.pollMs ?? DEFAULT_POLL_MS;
    let lost = 0;
    let n = 0;
    let last: Report | undefined;
    for (;;) {
        const remaining = deadline - i.now();
        if (remaining <= 0 || i.signal?.aborted) break;
        await i.sleep(Math.min(pollMs, remaining));
        n++;
        const answer = await i.env.exec(i.claimId, { stepId: `${i.key}:poll:${n}`, command: pollScript(dir, cwd, i.resultsGlob), timeoutMs: POLL_TIMEOUT_MS, ...where });
        const report = answered(answer) && answer.exitCode === 0 ? parseReport(answer.stdout) : undefined;
        if (!report) {
            if (++lost >= MAX_LOST_POLLS) return infra('transport_lost', { ...(last ? { logTail: last.logTail } : {}) });
            continue;
        }
        lost = 0;
        last = report;
        await i.onPoll?.({ resultFiles: report.files, logTail: report.logTail, elapsedMs: took() });
        if (report.state.kind === 'exited') {
            return report.files.length === 0 ? infra('no_result_file', { exitCode: report.state.code, logTail: report.logTail }) : { outcome: 'finished', exitCode: report.state.code, resultFiles: report.files, logTail: report.logTail, durationMs: took() };
        }
        if (report.state.kind === 'dead') {
            return report.files.length === 0 ? infra('no_result_file', { logTail: report.logTail }) : { outcome: 'crashed', resultFiles: report.files, logTail: report.logTail, durationMs: took() };
        }
    }
    // The shard's cap, or a cancel: stop the command and its children, then read what finished once more.
    const cancelled = !!i.signal?.aborted;
    await i.env.exec(i.claimId, { stepId: `${i.key}:kill`, command: killScript(dir), timeoutMs: POLL_TIMEOUT_MS, ...where });
    const final = await i.env.exec(i.claimId, { stepId: `${i.key}:poll:final`, command: pollScript(dir, cwd, i.resultsGlob), timeoutMs: POLL_TIMEOUT_MS, ...where });
    const report = (answered(final) && final.exitCode === 0 ? parseReport(final.stdout) : undefined) ?? last;
    return { outcome: cancelled ? 'cancelled' : 'timeout', resultFiles: report?.files ?? [], logTail: report?.logTail ?? '', durationMs: took() };
}

const answered = (r: StepResult | EnvError): r is StepResult => 'transport' in r && r.transport === 'ok';

interface Report {
    state: { kind: 'running' } | { kind: 'dead' } | { kind: 'exited'; code: number };
    files: string[];
    logTail: string;
}

function parseReport(stdout: string): Report | undefined {
    const lines = stdout.split('\n');
    const first = lines[0]?.startsWith('state=') ? lines[0].slice('state='.length).trim() : undefined;
    if (!first) return undefined;
    let state: Report['state'];
    if (first === POLL_STATES.running) state = { kind: 'running' };
    else if (first === POLL_STATES.dead) state = { kind: 'dead' };
    else if (first.startsWith(POLL_STATES.exited) && /^\d{1,3}$/.test(first.slice(POLL_STATES.exited.length))) state = { kind: 'exited', code: Number(first.slice(POLL_STATES.exited.length)) };
    else return undefined;
    const files: string[] = [];
    let i = 1;
    for (; i < lines.length && lines[i] !== 'log:'; i++) if (lines[i].startsWith('file=')) files.push(lines[i].slice('file='.length));
    return { state, files, logTail: lines.slice(i + 1).join('\n') };
}

/**
 * Starts the command once: the marker file makes a second start (a replay, a retried step) do nothing. The command
 * text goes through a quoted heredoc, so no character of it is read by the shell that writes it.
 */
function startScript(dir: string, cwd: string, command: string, env: Record<string, string>): string {
    const tag = `KODUS_SUITE_${createHash('sha256').update(command).digest('hex').slice(0, 16)}`;
    const exports = Object.entries(env).map(([k, v]) => `export ${k}=${quote(v)}`);
    const body = [...exports, command].join('\n');
    if (body.includes(tag)) throw new Error('the suite command contains its own end marker');
    return [
        `D=${quote(dir)}`,
        'mkdir -p "$D" || exit 1',
        'if [ ! -e "$D/started" ]; then',
        '  : > "$D/started"',
        `  cat > "$D/cmd.sh" <<'${tag}'`,
        body,
        tag,
        `  nohup sh -c 'cd "$1" && sh "$2"; echo $? > "$3/exit"' sh ${quote(cwd)} "$D/cmd.sh" "$D" > "$D/log" 2>&1 < /dev/null &`,
        '  echo $! > "$D/pid"',
        'fi',
    ].join('\n');
}

/** First line the state, then one `file=` line per result file, then `log:` and the tail of the log. */
function pollScript(dir: string, cwd: string, glob: string): string {
    return [
        `D=${quote(dir)}`,
        'alive() { [ -e "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; }',
        'if [ -e "$D/exit" ]; then echo "state=exited:$(cat "$D/exit")"',
        'elif alive; then echo state=running',
        'elif [ -e "$D/exit" ]; then echo "state=exited:$(cat "$D/exit")"',
        'else echo state=dead; fi',
        `cd ${quote(cwd)} 2>/dev/null && for f in ${glob}; do [ -e "$f" ] && echo "file=$f"; done`,
        'echo log:',
        `tail -c ${LOG_TAIL_BYTES} "$D/log" 2>/dev/null`,
        'exit 0',
    ].join('\n');
}

/** Stops the command and everything it started. */
function killScript(dir: string): string {
    return [
        `D=${quote(dir)}`,
        'killtree() { for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -TERM "$1" 2>/dev/null; }',
        '[ -e "$D/pid" ] && killtree "$(cat "$D/pid")"',
        'exit 0',
    ].join('\n');
}
