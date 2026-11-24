import type { EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { POLL_STATES } from './detached-exec';

// Test doubles of the suite engine: a clock the poller's sleeps move, and an environment that runs a suite
// command in fake time. Specs only.

export class SuiteClock {
    constructor(public t = Date.parse('2026-11-23T12:00:00Z')) {}
    now = () => this.t;
    sleep = async (ms: number) => {
        this.t += ms;
    };
}

export interface FakeSuiteRun {
    /** How long the command runs before it exits on its own. */
    runMs: number;
    exitCode?: number;
    /** The process dies this long after it started, with no exit status (the runner crashed or the host killed it). */
    diesAtMs?: number;
    /** Result files by the time (after the start) each appears. */
    resultsAt?: Record<string, number>;
    /** Polls (1-based) that answer a lost transport. */
    lostPolls?: number[];
}

/**
 * A cell's exec for a suite command: the start call begins the fake process (once: a second start with the same
 * key finds the marker and does nothing, as the real wrapper does), a poll reads it as of the clock, a kill ends it.
 * Calls are told apart by their step id suffix, which the poller owns.
 */
export class FakeSuiteEnvironment {
    readonly calls: Array<{ kind: 'start' | 'poll' | 'kill'; timeoutMs: number; command: string }> = [];
    /** How many times the command itself began running. */
    commandRuns = 0;
    private startedAt: number | undefined;
    private killedAt: number | undefined;
    private polls = 0;

    constructor(
        private readonly clock: { now(): number },
        private readonly run: FakeSuiteRun,
    ) {}

    async exec(_claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        const kind = req.stepId.endsWith(':start') ? 'start' : req.stepId.endsWith(':kill') ? 'kill' : 'poll';
        this.calls.push({ kind, timeoutMs: req.timeoutMs, command: req.command });
        if (kind === 'start') {
            if (this.startedAt === undefined) {
                this.startedAt = this.clock.now();
                this.commandRuns++;
            }
            return ok(req.stepId, '');
        }
        if (kind === 'kill') {
            this.killedAt ??= this.clock.now();
            return ok(req.stepId, '');
        }
        this.polls++;
        if (this.run.lostPolls?.includes(this.polls)) return { stepId: req.stepId, exitCode: -1, stdout: '', stderr: '', truncated: false, durationMs: 0, transport: 'lost' };
        const at = this.clock.now() - (this.startedAt ?? this.clock.now());
        const files = Object.entries(this.run.resultsAt ?? {}).filter(([, ms]) => ms <= at).map(([f]) => f);
        const killed = this.killedAt !== undefined;
        const dies = this.run.diesAtMs !== undefined && at >= this.run.diesAtMs;
        const exited = !killed && !dies && at >= this.run.runMs;
        const state = killed || dies ? POLL_STATES.dead : exited ? `${POLL_STATES.exited}${this.run.exitCode ?? 0}` : POLL_STATES.running;
        return ok(req.stepId, [`state=${state}`, ...files.map((f) => `file=${f}`), 'log:', `at ${Math.round(at / 1000)}s`].join('\n'));
    }
}

const ok = (stepId: string, stdout: string): StepResult => ({ stepId, exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok' });
