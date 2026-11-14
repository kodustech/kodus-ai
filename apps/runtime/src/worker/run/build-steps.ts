import type { ClaimTiming } from '@libs/runtime/environment';
import type { RunBuildSteps } from '@libs/runtime/run';
import { redactPatterns } from '@libs/runtime/redaction';

import { type Canary, redactCanaries } from '../canary/canary';

// Where a Run's boot builds spent their time (claim.ready timing.buildSteps,
// from a cell whose hub accepted them), for the Run page and run.finished.
// The cell already redacted and bounded the step names; they are cleaned
// again here, as everything from a cell is untrusted.

export const MAX_SLOWEST = 8;
const MAX_NAME = 160;
const MAX_SERVICE = 128;

const clean = (text: string, max: number, canaries: Canary[]) => redactCanaries(redactPatterns(String(text ?? '')).text, canaries).slice(0, max);
const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0);

/** One side's build steps for the projection; undefined when its cell sent none. */
export function buildStepsOf(side: 'base' | 'pr', timing: ClaimTiming | undefined, canaries: Canary[] = []): RunBuildSteps | undefined {
    const s = timing?.buildSteps;
    if (!s) return undefined;
    return {
        side,
        steps: count(s.steps),
        done: count(s.done),
        cached: count(s.cached),
        errored: count(s.errored),
        slowest: s.slowest.slice(0, MAX_SLOWEST).map((x) => ({ service: clean(x.service, MAX_SERVICE, canaries), name: clean(x.name, MAX_NAME, canaries), ms: count(x.ms) })),
    };
}

/** A side's timing as bootTiming keeps it: the phases only, the steps live in `buildSteps`. */
export function phasesOf(timing: ClaimTiming): Omit<ClaimTiming, 'buildSteps'> {
    const { buildSteps: _steps, ...phases } = timing;
    return phases;
}

/** The slowest steps of the Run for run.finished: which side and service, how long; never a step's name. */
export function slowestForLog(all: RunBuildSteps[], n = 3): Array<{ side: string; service: string; ms: number }> {
    return all
        .flatMap((b) => b.slowest.map((s) => ({ side: b.side, service: s.service, ms: s.ms })))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, n);
}
