import type { ProbeAssertions } from '@libs/runtime/contracts/probe-assertions';
import {
    KEPT_CHECK_SOURCE,
    KEPT_CHECKS_BUDGET_MS,
    type KeptCheck,
    type KeptCheckOutcome,
    keptCheckProbe,
    type KeptCheckStaleReason,
} from '@libs/runtime/contracts/kept-check';
import { coveredEntryPoint } from '@libs/runtime/entry-points';
import type { Claim } from '@libs/runtime/environment';
import { browserStepKindsOf, decideIntendedChange, type GateStep, keptCheckOutcomeOf, keptCheckStaleness, NORMALIZER_VERSION, type StabilityPolicy, stabilityPolicyFor } from '@libs/runtime/gate';
import { exercisedOf } from '@libs/runtime/probe/exercised';
import type { Probe } from '@libs/runtime/probe/probe.schema';
import { redactPatterns } from '@libs/runtime/redaction';
import type { ProbeVerdict, RuntimeRunRequested } from '@libs/runtime/run';

import type { RunDeps } from './ports';
import type { ReplayResult } from './replay';
import { type RunIdentityMismatch, skewedByIdentity, withRunIdentity } from './run-identity';

// The kept-check phase of a Run (docs/runtime/kept-checks.md §5): after the
// plan's probes, each kept check of the request is played on base and PR by
// the same replay and gate, within the phase's time budget. A check whose
// target is gone is not played; one main no longer has is stale. Every step
// id is derived from the request and the journal, so a resumed workflow
// plays the same checks in the same order.

/** What the phase did with one kept check, before intent: its outcome is settled from its final verdict. */
export interface PlayedKeptCheck {
    keptCheckId: string;
    /** The probe id it played under; absent when it was not played. */
    probeId?: string;
    stale?: KeptCheckStaleReason;
    skipped?: true;
}

export interface KeptPhaseInput {
    req: RuntimeRunRequested;
    deps: Pick<RunDeps, 'step' | 'now' | 'log'>;
    /** The base claim: its drawn identity is played on both sides (S-36). */
    base: Pick<Claim, 'identity'>;
    identityMismatch?: RunIdentityMismatch;
    /** The plan's probe count: kept checks take the indexes after it, so their rounds have their own step ids. */
    firstIndex: number;
    verdictEntryPoints: string[];
    /** The changed files that declare an entry point of the diff: the only ones an intended change is read from. */
    reachableFilesOf: (entryPoint: string) => string[];
    /** One probe on both sides through the gate: replayProbe with the Run's claims, image, evidence and canaries. */
    replay: (probe: Probe, index: number, opts: { assertions?: ProbeAssertions; stability: StabilityPolicy }) => Promise<ReplayResult>;
    /** Each played check's verdict and steps, as it settles: a halt keeps what was played. */
    onVerdict: (verdict: ProbeVerdict, steps: GateStep[]) => void;
    /** Filled in request order as the phase goes. */
    played: PlayedKeptCheck[];
}

/** Whether the environment still exposes what the probe targets: its service and port for http, an http service for a browser. */
function targetExposed(spec: KeptCheck['probe']['spec'], expose: RuntimeRunRequested['environment']['expose']): boolean {
    if (spec.kind === 'browser') return expose.some((e) => e.kind === 'http');
    return expose.some((e) => e.kind === 'http' && e.service === spec.target.service && e.port === spec.target.port);
}

export async function playKeptChecks(input: KeptPhaseInput): Promise<void> {
    const { req, deps, played } = input;
    const checks = req.keptChecks ?? [];
    if (!checks.length) return;
    const startedAt = await deps.step('kept:start', async () => deps.now().getTime());
    // A kept check never inherits the planner's history: the table's default, nothing known to vary.
    const stability = stabilityPolicyFor([]);
    let overBudget = false;
    for (const [k, check] of checks.entries()) {
        if (!targetExposed(check.probe.spec, req.environment.expose)) {
            played.push({ keptCheckId: check.keptCheckId, stale: 'target_gone' });
            continue;
        }
        // One journaled clock read per check: a resumed workflow reads the same answer.
        if (!overBudget) overBudget = !(await deps.step(`kept:${k}:budget`, async () => deps.now().getTime() - startedAt < KEPT_CHECKS_BUDGET_MS));
        if (overBudget) {
            played.push({ keptCheckId: check.keptCheckId, skipped: true });
            continue;
        }
        const kept = keptCheckProbe(check);
        const replayed = await input.replay(withRunIdentity(kept, input.base.identity), input.firstIndex + k, { ...(check.assertions ? { assertions: check.assertions } : {}), stability });
        const { steps } = replayed;
        const stale = keptCheckStaleness(steps, { keptStatus: check.assertions?.status });
        input.onVerdict(verdictOf(input, check, kept, replayed, stale, stability), steps);
        played.push({ keptCheckId: check.keptCheckId, probeId: kept.id, ...(stale ? { stale } : {}) });
    }
    deps.log?.info({
        msg: 'run.kept_checks',
        runId: req.runId,
        checks: checks.length,
        played: played.filter((p) => p.probeId).length,
        stale: played.filter((p) => p.stale).length,
        skipped: played.filter((p) => p.skipped).length,
    });
}

/** The played check as a probe verdict of the Run: the gate's, unless main no longer has what it guarded. */
function verdictOf(input: KeptPhaseInput, check: KeptCheck, kept: Probe, replayed: ReplayResult, stale: KeptCheckStaleReason | undefined, stability: StabilityPolicy): ProbeVerdict {
    const { steps, lanes, responseDiff } = replayed;
    const common = {
        probeId: kept.id,
        ...(exercisedOf(kept.spec) ? { exercised: exercisedOf(kept.spec)! } : {}),
        normalizerVersion: NORMALIZER_VERSION,
        stabilityPolicy: stability.snapshot,
        baseStepIds: steps.filter((x) => x.side === 'base').map((x) => x.stepId),
        prStepIds: steps.filter((x) => x.side === 'pr').map((x) => x.stepId),
        ...(lanes ? { lanes } : {}),
        ...(responseDiff ? { responseDiff } : {}),
        source: KEPT_CHECK_SOURCE,
        keptCheckId: check.keptCheckId,
    };
    // A stale check settles nothing: never a finding, never not_reproduced, on no entry point of the diff.
    if (stale) return { ...common, entryPoint: 'unmapped', verdict: 'inconclusive', reason: `kept check is stale: ${stale}`, differingFields: [] };
    const requestsOf = (side: 'base' | 'pr') => steps.filter((x) => x.side === side).flatMap((x) => x.requests ?? []);
    // Coverage of the diff comes from the observer's log on both sides, as for any probe.
    const entryPoint = coveredEntryPoint(check.entryPoint, input.verdictEntryPoints, { base: requestsOf('base'), pr: requestsOf('pr') });
    const intended = decideIntendedChange(replayed.decision, steps, {
        diff: input.req.diff,
        reachableFiles: input.reachableFilesOf(entryPoint),
        ...(kept.spec.kind === 'browser' ? { browserStepKinds: browserStepKindsOf(kept.spec.steps) } : {}),
    });
    const decision = skewedByIdentity(intended, kept, input.identityMismatch);
    const intendedChange = decision.intendedChange?.map((c) => ({ ...c, base: redactPatterns(c.base).text, pr: redactPatterns(c.pr).text }));
    return {
        ...common,
        entryPoint,
        verdict: decision.verdict,
        findingKind: decision.findingKind,
        intent: decision.verdict === 'finding' ? (intendedChange ? 'intended' : 'unintended') : undefined,
        reason: intendedChange ? redactPatterns(decision.reason).text : decision.reason,
        ...(intendedChange ? { intendedChange } : {}),
        differingFields: decision.differingFields,
    };
}

/**
 * Each kept check of the request with its outcome, in request order, from what
 * the phase did and the Run's final verdicts (after intent). A check the phase
 * never reached (the Run halted first) is skipped, never passed.
 */
export function keptOutcomesOf(checks: KeptCheck[], played: PlayedKeptCheck[], verdicts: ProbeVerdict[]): KeptCheckOutcome[] {
    return checks.map((check): KeptCheckOutcome => {
        const p = played.find((x) => x.keptCheckId === check.keptCheckId);
        const id = { keptCheckId: check.keptCheckId, ...(p?.probeId ? { probeId: p.probeId } : {}) };
        if (!p || p.skipped) return { ...id, outcome: 'skipped' };
        if (p.stale) return { ...id, outcome: 'stale', staleReason: p.stale };
        const v = verdicts.find((x) => x.probeId === p.probeId);
        return { ...id, outcome: v ? keptCheckOutcomeOf(v) : 'skipped' };
    });
}
