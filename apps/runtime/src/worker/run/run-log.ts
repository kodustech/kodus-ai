import type { RunBuildSteps, RuntimeRunRequested } from '@libs/runtime/run';

import { slowestForLog } from './build-steps';
import type { RunLogEvent } from './ports';

// The worker's lines about one Run: run.phase as each comment phase ends,
// and run.finished, the one line that says what the Run was and did. Ids,
// states and numbers only: never a token, repository content or model text.

/** The comment's phases (product screen 6) and what each one measures. */
/** capacity: the Run waited for room on a cell before its machines booted (ADR-070). */
export type RunPhase = 'capacity' | 'booting' | 'applying' | 'testing' | 'reporting';

/**
 * What the Run did, filled from step outputs as it goes, so a resumed
 * workflow fills it the same way.
 */
export interface RunTally {
    bootMs?: number;
    applyMs?: number;
    testMs?: number;
    reportMs?: number;
    probesPlanned?: number;
    /** Probes that reached a verdict other than inconclusive. */
    probesDecided?: number;
    findings?: number;
    explored?: number;
    exploreFailed?: number;
    inputTokens: number;
    outputTokens: number;
    tokenMeasurement?: 'partial' | 'unknown';
    /** What the Run asked the product to publish at its end (check, comment). */
    published?: string[];
    /** Each side's boot builds, step by step, when its cell sent them. */
    buildSteps?: RunBuildSteps[];
}

export const newTally = (): RunTally => ({ inputTokens: 0, outputTokens: 0 });

export function addTokens(t: RunTally, usage: { inputTokens: number; outputTokens: number; measurement?: 'partial' | 'unknown' } | undefined): void {
    if (!usage) return;
    t.inputTokens += Math.max(0, usage.inputTokens || 0);
    t.outputTokens += Math.max(0, usage.outputTokens || 0);
    if (t.tokenMeasurement || usage.measurement) t.tokenMeasurement = t.inputTokens + t.outputTokens > 0 ? 'partial' : 'unknown';
}

type RunIds = Pick<RuntimeRunRequested, 'runId' | 'attempt' | 'organizationId' | 'correlationId'>;

const ids = (run: RunIds) => ({ runId: run.runId, attempt: run.attempt, organizationId: run.organizationId, correlationId: run.correlationId });

/** run.phase: one comment phase ended, after ms. */
export function phaseLine(run: RunIds, phase: RunPhase, ms: number, extra: Record<string, string | number | boolean> = {}): RunLogEvent {
    return { msg: 'run.phase', ...ids(run), phase, ms: Math.max(0, Math.round(ms)), ...extra };
}

/** run.finished: the canonical line of a Run that reached its end state. */
export function finishedLine(
    req: RunIds & Partial<Pick<RuntimeRunRequested, 'trigger' | 'environment'>>,
    end: { state: string; verdictState?: string; totalMs?: number },
    t: RunTally,
): RunLogEvent {
    const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    return {
        msg: 'run.finished',
        ...ids(req),
        ...defined({
            environmentId: req.environment?.environmentId,
            trigger: req.trigger,
            state: end.state,
            verdictState: end.verdictState,
            totalMs: end.totalMs,
            bootMs: t.bootMs,
            applyMs: t.applyMs,
            testMs: t.testMs,
            reportMs: t.reportMs,
            probesPlanned: t.probesPlanned,
            probesDecided: t.probesDecided,
            findings: t.findings,
            explored: t.explored,
            exploreFailed: t.exploreFailed,
            tokenMeasurement: t.tokenMeasurement,
        }),
        ...(t.buildSteps?.length
            ? {
                  buildSteps: t.buildSteps.reduce((n, b) => n + b.steps, 0),
                  buildCached: t.buildSteps.reduce((n, b) => n + b.cached, 0),
                  // Which side and service, how long: the step names stay on the Run page.
                  slowestBuildSteps: slowestForLog(t.buildSteps),
              }
            : {}),
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        published: t.published ?? [],
    };
}
