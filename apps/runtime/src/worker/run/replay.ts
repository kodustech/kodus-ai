import { decideProbe, GateDecision, GateStep, StabilityPolicy, type StatedIntentCheck } from '@libs/runtime/gate';
import { EnvironmentRuntime, isEnvError } from '@libs/runtime/environment';
import type { ProbeOutcome } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import type { ProbeAssertions } from '@libs/runtime/contracts/probe-assertions';
import { laneOf, type ReplayLane, type ReplayLanes, replayLanesOf } from '@libs/runtime/run/replay-lanes';
import { type ResponseDiff, responseDiffOf, type ResponseSample, responseTextSample } from '@libs/runtime/run/response-diff';
import { redactPatterns } from '@libs/runtime/redaction';

import { Canary, CanaryLeakError, containsCanary, redactCanaries, redactDeep } from '../canary/canary';
import { type ReadyTarget, RUN_READY_INTERVAL_MS, waitUntilReady } from '../env/ready-check';
import { checkClaimLease, type ClaimLeaseFailed, throwClaimLeaseFailure } from '../env/claim-liveness';
import type { StepRunner } from './ports';
import { toGateStep } from './probe-fields';
import { type BrowserBaseline, checkUploadedRefs, envErrorEvidence, evidenceRequestOf, putStepOutput, type RunEvidence } from './run-evidence';
import { isSecurityViolation, SecurityViolationError } from './security-violation';
import { stableStepId } from './step-id';

// Replay (ADR-050): every round starts from the same state (machine.reset by
// the cell, outside the guest), base twice and the PR once, plus what the gate
// asks for. Each round is one durable step, so a resumed workflow never runs
// a round that nobody recorded.
//
// The two sides are separate claims on separate machines, so a base round and
// a PR round run side by side (runBatch): a batch of two base rounds and one
// PR round takes two rounds of wall time, not three. Each pair starts its steps
// base first, in one synchronous call, so a durable runner numbers them the
// same way on every execution; results are applied base first, as one after
// the other would.

export interface ReplayResult {
    decision: Extract<GateDecision, { kind: 'verdict' }>;
    steps: GateStep[];
    /** Main and the PR on one clock, from the first healthy round of each side; absent when a side has none. */
    lanes?: ReplayLanes;
    /** What the two answers differ in, field by field, from the same rounds as the lanes; absent when they match or a side has none. */
    responseDiff?: ResponseDiff;
}

/** What the cell captures around every probe round (EVIDENCE-CAPTURE-DESIGN); the hub trims it to the cell's features. */
const ROUND_CAPTURE = ['logs', 'db', 'outbound'] as const;
/** A browser probe's round: the runner's artifacts and the back end of the same window (ADR-071). */
const BROWSER_ROUND_CAPTURE = ['logs', 'outbound', 'browser'] as const;

/**
 * The clock a browser probe's page reads when the probe sets none: one
 * fixed instant for every round of both sides, so a date on the page is
 * never the difference.
 */
export const BROWSER_DEFAULT_CLOCK = '2030-01-01T00:00:00.000Z';

/** The probe as the cell plays it: a browser probe always on a fixed clock. */
function probeToPlay(probe: Probe): Probe {
    if (probe.spec.kind !== 'browser' || probe.spec.clock) return probe;
    return { ...probe, spec: { ...probe.spec, clock: BROWSER_DEFAULT_CLOCK } };
}

/** The screenshots a healthy baseline round uploaded, by the step that took each. */
function baselineShots(result: ProbeOutcome, refs: Array<{ type: string }>): BrowserBaseline['shots'] {
    const uploaded = new Set(refs.map((r) => r.type));
    return (result.browser?.steps ?? [])
        .filter((s) => s.kind === 'screenshot' && s.ok && s.screenshot !== undefined && uploaded.has(`screenshot-${s.screenshot}`))
        .map((s) => ({ step: s.index, screenshot: s.screenshot! }));
}

/** What one round recorded: the gate's step and what the replay applies from it, or a claim that could not run it. */
export type RoundOut = ClaimLeaseFailed | { gate: GateStep; leaked: boolean; violation?: string; lane?: ReplayLane; text?: ResponseSample['text']; baseline?: BrowserBaseline };

export interface ReplayArgs {
    /** workflowID and attempt: the stepId of each round is derived from them, so a retried step keeps it. */
    run: { runId: string; attempt: number };
    /** Index of the probe in the plan; two probes with the same id still get distinct steps. */
    index: number;
    probe: Probe;
    assertions?: ProbeAssertions;
    /** An intent probe's quoted assertions: what each round expects (gate/stated-intent.ts). */
    intent?: StatedIntentCheck[];
    securityOf?: (claimId: string) => Promise<string | undefined>;
    claims: { base: string; pr: string };
    pinnedImageId: string;
    /** Each side's round snapshot: its resets restore it instead of the compose volumes. */
    rounds?: { base?: string; pr?: string };
    env: EnvironmentRuntime;
    step: StepRunner;
    maxRoundsPerSide?: number;
    /**
     * The probe's stability policy from its history (gate/stability.ts): how many base
     * rounds it starts with and the fields known to vary on the base. Absent: the table's
     * default, two base rounds and nothing known.
     */
    stability?: Pick<StabilityPolicy, 'baseRounds' | 'knownUnstableFields'>;
    onStep?: (s: GateStep) => Promise<void>;
    /** The Run's canaries: one in the observer's result stops the replay (ADR-043). */
    canaries?: Canary[];
    /**
     * Where each round's evidence goes, at {orgId}/{runId}/{side}/{stepId}/output (§8): the
     * observer's result, or why the round has none (the reset or the probe failed).
     */
    evidence?: RunEvidence;
    /**
     * The setup's ready check: after the reset the round asks it until the app
     * answers (or its wait passes), then sends the probe. The reset takes the
     * project down and compose up does not wait for the app to listen again.
     */
    ready?: ReadyTarget;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * The probe's first base round, already played (playFirstBaseRound) while
     * the PR side still built: applied as base round 1, so the first batch is
     * the base's second round beside the PR's first.
     */
    firstBaseRound?: RoundOut;
}

/** What a round needs from the replay's arguments. */
type RoundArgs = Pick<ReplayArgs, 'run' | 'index' | 'probe' | 'assertions' | 'intent' | 'securityOf' | 'claims' | 'pinnedImageId' | 'rounds' | 'env' | 'canaries' | 'evidence' | 'ready' | 'now' | 'sleep'>;

/** The step name of one round: the same whether the replay or playFirstBaseRound plays it, so its stepId and evidence are the same. */
const roundName = (args: Pick<RoundArgs, 'index' | 'probe'>, side: 'base' | 'pr', round: number) => `probe:${args.index}:${args.probe.id}:${side}:${round}`;

/**
 * The body of one round (one durable step of the replay): the side's claim
 * lease, the reset, the ready wait, the probe, its evidence and canary checks.
 * knownBaseline: the browser baseline known when the round starts;
 * sideHasLane: whether an earlier round of the side already gave its lane.
 */
async function playRoundBody(args: RoundArgs, side: 'base' | 'pr', round: number, knownBaseline: BrowserBaseline | undefined, sideHasLane: boolean): Promise<RoundOut> {
    const { probe, claims, env } = args;
    const now = args.now ?? Date.now;
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const browser = probe.spec.kind === 'browser';
    const toPlay = probeToPlay(probe);
    const clean = (text: string) => redactCanaries(redactPatterns(text).text, args.canaries ?? []);
    const name = roundName(args, side, round);
    const stepId = stableStepId(args.run.runId, args.run.attempt, name);
    const head = (id: string) => ({ probeId: probe.id, side, round, stepId: id });
    const claimFailure = await checkClaimLease(env, claims[side], 'runtime', { side, securityOf: args.securityOf });
    if (claimFailure) return { claimFailure };
    // A side without a round resets as before: the call names no round at all.
    const snapshotId = args.rounds?.[side];
    const reset = await (snapshotId ? env.reset(claims[side], args.pinnedImageId, snapshotId) : env.reset(claims[side], args.pinnedImageId));
    if (isSecurityViolation(reset)) return { gate: toGateStep({ probe, side, round, stepId, result: { code: 'transport_lost', stepId } }), leaked: false, violation: reset.signature };
    if (reset && 'code' in reset) {
        if (args.evidence) await putStepOutput(args.evidence, { runId: args.run.runId, side, stepId }, { ...head(stepId), stage: 'reset', error: envErrorEvidence(reset) });
        return { gate: toGateStep({ probe, side, round, stepId, result: reset }), leaked: false };
    }
    // Inside the round's step: a resumed workflow reads the round and never waits again.
    // What the health path answered is kept on the round: the gate reads it before it calls a route absent on main.
    let readyStatus: number | undefined;
    if (args.ready) {
        const readiness = await waitUntilReady({
            env,
            claimId: claims[side],
            target: args.ready,
            who: { id: 'run-ready', purpose: 'the app answers again after the reset' },
            stepIdOf: (i) => stableStepId(args.run.runId, args.run.attempt, `${name}:ready:${i}`),
            // A PR that breaks the health path itself still gets compared.
            acceptStableError: true,
            intervalMs: RUN_READY_INTERVAL_MS,
            now,
            sleep,
        });
        const last = readiness.last;
        if (last && !isEnvError(last) && last.http) readyStatus = last.http.status;
    }
    // Issued here, right before the probe, so a grant lives the probe's timeout and not the reset's.
    const at = { runId: args.run.runId, side, stepId };
    const capture = browser ? [...BROWSER_ROUND_CAPTURE] : [...ROUND_CAPTURE];
    const raw = await env.probe(claims[side], toPlay, stepId, evidenceRequestOf(args.evidence, at, capture, probe.spec.timeoutMs, knownBaseline, probe.evidence));
    if (isSecurityViolation(raw)) return { gate: toGateStep({ probe, side, round, stepId, result: { code: 'transport_lost', stepId } }), leaked: false, violation: raw.signature };
    // The checkpoint keeps only the redacted result; the value never reaches a GateStep.
    let leaked = !!args.canaries?.length && containsCanary(JSON.stringify(raw), args.canaries);
    let result = leaked ? redactDeep(raw, args.canaries!) : raw;
    if (!('code' in result) && result.evidence) {
        // The artifacts the cell uploaded are read back for canaries before anyone can open them (ADR-043).
        const checked = await checkUploadedRefs(args.evidence, at, result.evidence.refs, args.canaries);
        leaked ||= checked.leaked;
        // The rows themselves travel only in the db artifact, never in the checkpoint.
        const { sample: _rows, ...db } = result.evidence.db ?? ({} as NonNullable<typeof result.evidence.db>);
        result = { ...result, evidence: { ...result.evidence, refs: checked.refs, ...(result.evidence.db ? { db } : {}) } };
    }
    // The first healthy base round of a browser probe is the baseline: its screenshots are `same` by definition.
    const isBaseline = browser && side === 'base' && !knownBaseline && !('code' in result) && result.transport === 'ok' && (result.vmHealth ?? 'ok') === 'ok' && !!result.browser?.steps?.length;
    const gate = toGateStep({ probe, assertions: args.assertions, intent: args.intent, side, round, stepId: 'stepId' in result ? result.stepId : stepId, result, baselineRound: isBaseline, readyStatus });
    // Inside the step: a resumed workflow does not write it twice. Only the redacted result, never a canary;
    // a round without one says why, so the Run page never links to nothing.
    if (args.evidence) {
        const body = 'code' in result ? { ...head(gate.stepId), stage: 'probe', error: envErrorEvidence(result) } : { ...head(gate.stepId), result };
        await putStepOutput(args.evidence, { runId: args.run.runId, side, stepId: gate.stepId }, body);
    }
    // A lane only from a round that answered on a healthy machine: it shows what the app did, not a lost link.
    const lane = !('code' in result) && result.transport === 'ok' && (result.vmHealth ?? 'ok') === 'ok' ? laneOf({ side, round, stepId: gate.stepId, result, probe }) : undefined;
    // A body that is not JSON has no fields to diff: the lines of the side's first healthy round are kept, cleaned and cut.
    const text = lane && !sideHasLane && !('code' in result) && result.http && gate.fields.json === 'not_json' ? responseTextSample(result.http.body, clean) : undefined;
    const nextBaseline = isBaseline && !('code' in result) ? { stepId: gate.stepId, shots: baselineShots(result, result.evidence?.refs ?? []) } : undefined;
    return { gate, leaked, ...(lane ? { lane } : {}), ...(text ? { text } : {}), ...(nextBaseline ? { baseline: nextBaseline } : {}) };
}

/**
 * A probe's first base round, played on its own before the replay (while the
 * PR side still builds, early-plan.ts): the same reset, probe, stepId and
 * evidence as the replay's base round 1. Not a durable step of its own: the
 * caller runs it inside one, and replayProbe applies what it returned
 * (ReplayArgs.firstBaseRound).
 */
export function playFirstBaseRound(args: Omit<RoundArgs, 'claims'> & { baseClaimId: string }): Promise<RoundOut> {
    const { baseClaimId, ...rest } = args;
    // Only the base side plays here: no PR claim is read.
    return playRoundBody({ ...rest, claims: { base: baseClaimId, pr: '' } }, 'base', 1, undefined, false);
}

export async function replayProbe(args: ReplayArgs): Promise<ReplayResult> {
    const { probe, step } = args;
    const maxRounds = args.maxRoundsPerSide ?? 4;
    const steps: GateStep[] = [];
    const rounds = { base: 0, pr: 0 };
    const lanes: { base?: ReplayLane; pr?: ReplayLane } = {};
    const answers: { base?: ResponseSample; pr?: ResponseSample } = {};
    // A browser probe's baseline round (main's first healthy one): every later round diffs its screenshots against it.
    let baseline: BrowserBaseline | undefined;
    const browser = probe.spec.kind === 'browser';
    // Token patterns, then the Run's canaries: what the cell's claim redactor left is cleaned again before it is kept.
    const clean = (text: string) => redactCanaries(redactPatterns(text).text, args.canaries ?? []);

    // Starts one round's durable step. No await before step(): the step is
    // numbered when this is called, so runBatch decides the order.
    const playRound = (side: 'base' | 'pr'): Promise<{ side: 'base' | 'pr'; out: RoundOut }> => {
        const round = ++rounds[side];
        // The baseline this round diffs against, and whether its side has a lane: what is known when it starts.
        const knownBaseline = baseline;
        const sideHasLane = !!lanes[side];
        const played = step(roundName(args, side, round), () => playRoundBody(args, side, round, knownBaseline, sideHasLane));
        return played.then((out) => ({ side, out }));
    };

    // What a round's recorded result changes, in the order one round after the other would.
    const applyRound = async ({ side, out }: { side: 'base' | 'pr'; out: RoundOut }) => {
        if ('claimFailure' in out) throwClaimLeaseFailure(out.claimFailure);
        // From the recorded step, so a resumed workflow diffs against the same round.
        if (out.baseline && !baseline) baseline = out.baseline;
        // Thrown outside the step, so a resumed workflow replays the recorded leak and halts the same way.
        if (out.violation) throw new SecurityViolationError(side, out.violation);
        if (out.leaked) throw new CanaryLeakError('probe_output');
        const s = out.gate;
        if (out.lane && !lanes[side]) {
            lanes[side] = out.lane;
            answers[side] = { fields: s.fields, ...(out.text ? { text: out.text } : {}) };
        }
        return s;
    };
    const keepStep = async (s: GateStep) => {
        steps.push(s);
        await args.onStep?.(s);
    };

    // One batch of rounds, a base round and a PR round side by side. A browser
    // probe's PR round waits for the base round that gives its baseline, as one
    // after the other did. Both rounds of a pair end before either is applied,
    // so a halt never leaves a step running; the base round is applied first.
    // Steps are kept base rounds first, then the PR's, as one after the other kept them.
    const runBatch = async (pending: { base: number; pr: number }) => {
        const left = { ...pending };
        const prSteps: GateStep[] = [];
        while (left.base > 0 || left.pr > 0) {
            const baseAlone = browser && !baseline && left.base > 0;
            const sides = (['base', 'pr'] as const).filter((s) => left[s] > 0 && !(s === 'pr' && baseAlone));
            for (const s of sides) left[s]--;
            const settled = await Promise.allSettled(sides.map((s) => playRound(s)));
            for (const r of settled) {
                if (r.status === 'rejected') throw r.reason;
                const s = await applyRound(r.value);
                if (r.value.side === 'pr') prSteps.push(s);
                else await keepStep(s);
            }
        }
        for (const s of prSteps) await keepStep(s);
    };

    // A first base round played before the replay counts as base round 1, applied as one after the other would.
    if (args.firstBaseRound) {
        rounds.base = 1;
        await keepStep(await applyRound({ side: 'base', out: args.firstBaseRound }));
    }
    const knownUnstableFields = args.stability?.knownUnstableFields ?? [];
    const startBase = Math.min(Math.max(2, args.stability?.baseRounds ?? 2), maxRounds);
    let pending = { base: startBase - rounds.base, pr: 1 };
    for (let guard = 0; guard < maxRounds * 2 + 2; guard++) {
        await runBatch(pending);
        const d = decideProbe(steps, { pinnedImageId: args.pinnedImageId, maxRoundsPerSide: maxRounds, ...(knownUnstableFields.length ? { knownUnstableFields } : {}) });
        if (d.kind === 'verdict') return { decision: d, steps, ...lanesOf(d.differingFields), ...diffOf(d.differingFields, d.maskedFields) };
        if (rounds.base + d.base > maxRounds || rounds.pr + d.pr > maxRounds) break;
        pending = { base: d.base, pr: d.pr };
    }
    return {
        decision: { kind: 'verdict', verdict: 'inconclusive', reason: 'round limit reached', differingFields: [], maskedFields: [] },
        steps,
        ...lanesOf([]),
        ...diffOf([], []),
    };

    /** Shown only: the verdict is already decided, this never changes it. */
    function diffOf(differing: string[], masked: string[]): { responseDiff?: ResponseDiff } {
        if (!answers.base || !answers.pr) return {};
        const responseDiff = responseDiffOf({ base: answers.base, pr: answers.pr, differing, masked, clean });
        return responseDiff ? { responseDiff } : {};
    }

    function lanesOf(differingFields: string[]): { lanes?: ReplayLanes } {
        if (!lanes.base || !lanes.pr) return {};
        return { lanes: replayLanesOf(lanes.base, lanes.pr, { responseDiffers: differingFields.length > 0 }) };
    }
}
