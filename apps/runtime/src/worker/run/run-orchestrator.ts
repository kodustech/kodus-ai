import { coveredEntryPoint, diffRefOf, extractEntryPoints, noRuntimeEffectOf } from '@libs/runtime/entry-points';
import { exercisedOf } from '@libs/runtime/probe/exercised';
import { AcquireRequest, Blocked, Claim, isBlocked, isCapacityWait, readyDeadlineOf } from '@libs/runtime/environment';
import { browserStepKindsOf, decideIntendedChange, decideNewEndpoint, GateStep, LATEST_IMAGE, markUnbackedClaims } from '@libs/runtime/gate';
import {
    canTransition,
    decideRunVerdict,
    NOTHING_TO_TEST,
    blockerAliasOf,
    checkConclusionFor,
    claimShaOf,
    type CommentPhase,
    withMemberTokens,
    isForkApprovalRequired,
    isNewEndpointError,
    isTerminal,
    type Observed,
    ProbeVerdict,
    publishKey,
    reproductionFor,
    RunState,
    RuntimeRunRequested,
    VerdictOutcome,
    VerdictState,
} from '@libs/runtime/run';
import { bootFailureOf, type RunBootFailure } from '@libs/runtime/run/boot-failure';
import { redactPatterns } from '@libs/runtime/redaction';
import { ATTR, withRunSpan } from '@libs/runtime/telemetry';
import { safeFailure } from '@libs/runtime/telemetry/failure';

import { LlmBudgetExceededError, LlmUnavailableError } from '../agent/llm-gateway';
import type { AgentPlan } from '../agent/runtime-agent';
import { Canary, canaryLeakSite, containsCanary, LeakSite, redactCanaries, redactDeep } from '../canary/canary';
import { acquireWaitingForRoom, capacityWaitReason } from '../env/capacity-wait';
import { classifyIntents } from '../intent/intent-classifier';
import { runPlannedTests, TestRun } from '../intent/test-runs';
import { buildComment } from './comment';
import { changesOnlyTheRecipe, memberNotBootedOf, recipeChangedInPr } from './recipe-change';
import { planReuseKey } from './plan-reuse';
import { TEST_PLANNER_VERSION } from '@libs/runtime/planner/test-planner.agent';
import type { ForkApprovals, RunDeps } from './ports';
import { RunLeaseHolds } from './lease-keeper';
import { checkClaimLease, type ClaimLeaseFailed, throwClaimLeaseFailure } from '../env/claim-liveness';
import { isCancellation } from '../workflow-cancellation';
import { type SecurityViolation, SecurityViolationError } from './security-violation';
import { playFirstBaseRound, replayProbe, type RoundOut } from './replay';
import { stableStepId } from './step-id';
import { claimIdFor } from '../../shared/claim-id';
import { externalVerificationPlan } from './external-verification';
import { bootBlockerOf, entryPointsWithRoutes, infraBootBlocker, uncoveredByBoot, uncoveredByMemberNotBooted, uncoveredOf, buildReport, observedOf } from './report';
import { buildStepsOf, phasesOf } from './build-steps';
import { type PhaseEstimates, phaseEstimates } from './run-estimates';
import type { RunEvidence } from './run-evidence';
import { addTokens, finishedLine, newTally, phaseLine, type RunTally } from './run-log';
import { type EarlyPlan, type FirstBaseRounds, type FirstSide, planWhileThePrBoots } from './early-plan';

// The body of the Run workflow. Every transition and every
// side effect is one step, so DBOS resumes a Run from its last checkpoint.

/** The taxonomy attributes every span of a Run carries (ids on spans, never on metrics). */
export const runSpanAttributes = (req: RuntimeRunRequested) => ({
    [ATTR.runId]: req.runId,
    [ATTR.runAttempt]: req.attempt,
    [ATTR.runTrigger]: req.trigger,
    [ATTR.organizationId]: req.organizationId,
    [ATTR.teamId]: req.teamId,
    [ATTR.repositoryId]: req.repository.id,
    [ATTR.prNumber]: req.pullRequest.number,
    [ATTR.environmentId]: req.environment.environmentId,
});

export const QUEUE_TIMEOUT_MS = 30 * 60_000;
export const RUN_TIMEOUT_MS = 45 * 60_000;

export interface RunResult {
    state: RunState;
    verdictState?: VerdictState;
    conclusion?: string;
    title?: string;
}

class RunAbort extends Error {
    constructor(
        readonly state: RunState,
        readonly reason: string,
    ) {
        super(reason);
    }
}

const unresolvedImage = (c: Claim): boolean => !c.manifest.imageId?.trim() || c.manifest.imageId === LATEST_IMAGE;

/**
 * Both sides came up, and neither names a prepared image: the cell that took
 * the Run holds no bake of the environment (a new or reinstalled cell, or a
 * setup that ran on another one). Nothing pins the two sides to one image, so
 * the Run does not test; it says what is missing and what to do, the setup
 * again, instead of "could not finish, run again" (kr-shop #2 on the dev cell).
 * One side without an image while the other has one is a fault, not this.
 */
export const ENVIRONMENT_NOT_PREPARED = {
    kind: 'platform',
    signature: 'environment_not_prepared',
    message: 'the cell that took this Run has no prepared image of the environment; the environment has to be set up again',
} as const;

/** Resolve aliases from durable acquire outputs, never from a process-local claim cache. */
function acquiredImagePin(requested: string, base: Claim, pr: Claim): string {
    const imageId = base.manifest.imageId;
    if (!imageId?.trim() || imageId === LATEST_IMAGE || !pr.manifest.imageId?.trim() || pr.manifest.imageId === LATEST_IMAGE) {
        throw new RunAbort('errored', 'the acquired claims did not resolve a concrete environment image');
    }
    if (imageId !== pr.manifest.imageId) {
        throw new RunAbort('errored', 'the base and PR claims acquired different environment images');
    }
    if (requested !== LATEST_IMAGE && requested !== imageId) {
        throw new RunAbort('errored', 'the acquired environment image differs from the requested image');
    }
    return imageId;
}

/** What a state transition and a publication touch. */
type RecordDeps = Pick<RunDeps, 'step' | 'projection' | 'events' | 'metrics' | 'now'>;
type PublishDeps = Pick<RunDeps, 'step' | 'projection' | 'events' | 'publisher' | 'now'>;

export async function transition(
    deps: RecordDeps,
    req: Pick<RuntimeRunRequested, 'runId' | 'organizationId'> & { attempt?: number; trigger?: string },
    to: RunState,
    patch: Record<string, unknown> = {},
): Promise<boolean> {
    return deps.step(`state:${to}`, async () => {
        const current = await deps.projection.get(req.runId);
        const from = current?.state ?? 'queued';
        if (from !== to && !canTransition(from, to)) return false;
        const at = deps.now().toISOString();
        await deps.projection.upsert(req.runId, { state: to, ...patch, ...(isTerminal(to) ? { finishedAt: at } : {}) });
        await deps.events.append(req.organizationId, req.runId, { type: 'state', at, data: { state: to, ...patch } }, `${req.attempt ?? 1}:state:${to}`);
        deps.metrics.recordRunState(to, { orgId: req.organizationId, trigger: req.trigger });
        return true;
    });
}

const withObserved = <S extends 'base' | 'pr'>(side: S, o: Observed | undefined) => (o ? ({ [side]: o } as Partial<Record<S, Observed>>) : {});

/** `renewed`: a second claim for a side whose first claim could not live to the Run's end (renewShortLived). */
/** One side's acquire key: what the hub knows its claim (and its claim.progress) by. */
const acquireKey = (req: RuntimeRunRequested, side: 'base' | 'pr', renewed = false) => `${req.runId}:${side}:${req.attempt}${renewed ? ':renewed' : ''}`;

export function acquireRequest(req: RuntimeRunRequested, side: 'base' | 'pr', renewed = false, canaries: Canary[] = []): AcquireRequest {
    return {
        organizationId: req.organizationId,
        environmentId: req.environment.environmentId,
        runId: req.runId,
        imageId: req.environment.imageId,
        // The primary's commit for the side: the PR's own, unless the PR is in another repository of the workspace.
        ref: { side, sha: claimShaOf(req, side) },
        consumer: 'runtime',
        idempotencyKey: acquireKey(req, side, renewed),
        ...(req.environment.recipe ? { recipe: req.environment.recipe } : {}),
        ...(req.environment.size ? { size: req.environment.size } : {}),
        // Planted by the cell in both sides' workloads: a sighting anywhere halts the Run.
        ...(canaries.length ? { canaries: canaries.map((c) => ({ slot: c.slot, value: c.value })) } : {}),
        // The PR side of a fork runs code nobody in the org wrote: the environment's approved egress hosts never reach it.
        ...(side === 'pr' && req.pullRequest.fork ? { forkPullRequest: true } : {}),
    };
}

/** waitedMs: how long the side waited for room on a cell before its claim was answered. */
/**
 * roundSnapshotId: the claim's round snapshot (claim.snapshot round), taken in
 * the acquire's own step once the claim was ready (RunDeps.roundSnapshots); a
 * replay or test reset names it. Absent: resets go back to the compose volumes.
 */
type Booted = { claim: Claim | Blocked; readyAt: string; waitedMs?: number; roundSnapshotId?: string };
type AcquireTry = Booted | { error: string };

/** Until when a side may wait for room on a cell (epoch ms), and where a wait is shown. */
interface RoomBudget {
    until: number;
    noCapacityWait?: boolean;
    onWait: (side: 'base' | 'pr', w: { blocked: Blocked; waitedMs: number }) => Promise<void>;
}

/**
 * One acquire as one durable step; a thrown error (lost cell) comes back as
 * a value. A claim refused for room (no slot, no memory) is asked again
 * inside the same step until it is admitted or the budget ends:
 * nothing started, so the step only returns once the cell answered.
 */
async function tryAcquire(
    deps: RunDeps,
    req: RuntimeRunRequested,
    side: 'base' | 'pr',
    attempt: number | 'renewed',
    room?: RoomBudget,
    /** Awaited inside the step before anything is sent (the PR's first acquire waits for the base's to start: baseStarted). */
    before?: () => Promise<void>,
): Promise<AcquireTry> {
    // Derived again here, never a step's input or output: a DBOS checkpoint never holds a canary.
    const request = acquireRequest(req, side, attempt === 'renewed', deps.canaries.forRun(req));
    try {
        return await deps.step(`acquire:${side}:${attempt}`, async () => {
            await before?.();
            const env = await creditedEnv(deps, req, request);
            if (!room || room.noCapacityWait) return withRound(deps, req, side, attempt, { claim: await env.acquire(request), readyAt: deps.now().toISOString() });
            const r = await acquireWaitingForRoom(env, request, {
                until: room.until,
                now: deps.now,
                signal: deps.cancellationSignal?.(),
                ...(deps.sleep ? { sleep: deps.sleep } : {}),
                onWait: (w) => room.onWait(side, w),
            });
            return withRound(deps, req, side, attempt, { claim: r.claim, readyAt: deps.now().toISOString(), ...(r.rounds > 1 ? { waitedMs: r.waitedMs } : {}) });
        });
    } catch (e) {
        if (isCancellation(e)) throw e;
        return { error: (e as Error)?.message ?? 'unknown error' };
    }
}

/**
 * The acquire as this execution of its step sends it. A claim whose boot round
 * the hub recorded before this execution began (the worker restarted while the
 * step waited, or the step runs again after a lost cell) waits only what is
 * left of its ready wait, counted from that round's start (readyDeadlineOf), and
 * is boot_timeout once it passed: a hub that starts a new round waits a fresh
 * ready wait (claim-deadlines.ts readyWaitMs), so without this a restart during
 * a 15-minute PR build gave the boot up to 30 minutes more. Read once, before
 * the first call: a claim this execution itself started keeps the hub's wait.
 */
async function creditedEnv(deps: RunDeps, req: RuntimeRunRequested, request: AcquireRequest): Promise<Pick<RunDeps['env'], 'acquire'>> {
    if (!deps.claims.hardExpiryOf) return deps.env;
    const claimId = claimIdFor(req.organizationId, request.idempotencyKey);
    const hard = await deps.claims.hardExpiryOf(req.organizationId, claimId).catch(() => undefined);
    if (!hard) return deps.env;
    const readyBy = readyDeadlineOf(hard, request.consumer, request.ref.side);
    deps.log?.info({ msg: 'run.acquire.ready_credited', runId: req.runId, side: request.ref.side, claimId, readyBy: new Date(readyBy).toISOString() });
    return { acquire: (r) => deps.env.acquire(r, { readyBy }) };
}

/**
 * The side's round snapshot, inside its acquire step: in the same step, so a
 * resumed workflow replays the same steps in the same order and reads the
 * round from the acquire's checkpoint (a workflow checkpointed before rounds
 * existed has none and resets compose volumes). Taken before the agent plans
 * or explores, so every reset goes back to the state at first ready; readyAt
 * stays the boot's own. A cell that keeps no snapshots, or refuses this one,
 * leaves the side without a round.
 */
async function withRound(deps: RunDeps, req: RuntimeRunRequested, side: 'base' | 'pr', attempt: number | 'renewed', b: Booted): Promise<Booted> {
    if (!deps.roundSnapshots || !deps.env.snapshotRound || isBlocked(b.claim)) return b;
    const r = await deps.env.snapshotRound(b.claim.claimId, stableStepId(req.runId, req.attempt, `round:${side}:${attempt}`));
    if ('code' in r) {
        // A cell that keeps no memory snapshots (gVisor) answers this for every Run: not a warning.
        deps.log?.info({ msg: 'run.round.none', runId: req.runId, side, claimId: b.claim.claimId, code: r.code });
        return b;
    }
    deps.log?.info({ msg: 'run.round', runId: req.runId, side, claimId: b.claim.claimId, ms: r.ms });
    return { ...b, roundSnapshotId: r.id };
}

/** How long the PR's first acquire waits for the base's claim to start on a cell before it is sent anyway. */
export const BASE_FIRST_MAX_MS = 20_000;
/** How often the base's claim.progress is read meanwhile. */
export const BASE_FIRST_POLL_MS = 1_000;

/**
 * The base's claim is admitted before the PR's (review P5). A cell's memory
 * admission counts a booting claim at its whole size (the setup's, 12 GB on
 * the dev cell), so two sides sent at once race for it: when the PR wins, the
 * base waits for the PR's whole build (kr-shop #6: 33 s), and
 * the plan, which starts from the base, cannot overlap that build. A base
 * from the bake is ready in seconds, so with the base first the PR waits
 * those seconds and the plan runs beside its build; with room for both the
 * PR goes out as soon as the base started. Done inside the PR's step: its
 * place among the steps does not change.
 *
 * Resolves when the base's claim reports any phase (the cell took it), when
 * its acquire answered, or after BASE_FIRST_MAX_MS (a base still waiting for
 * room: the PR then waits behind it in the cell's line). An environment that
 * reports no progress sends both at once, as before.
 */
async function baseStarted(deps: RunDeps, req: RuntimeRunRequested, base: Promise<unknown>): Promise<void> {
    const progress = deps.env.progress?.bind(deps.env);
    if (!progress) return;
    let settled = false;
    const done = base.then(
        () => void (settled = true),
        () => void (settled = true),
    );
    const until = Date.now() + BASE_FIRST_MAX_MS;
    const key = acquireKey(req, 'base');
    while (!settled && Date.now() < until) {
        const p = await progress({ organizationId: req.organizationId, idempotencyKey: key }).catch(() => null);
        if (p?.phases.length) return;
        await waitOrSettled(Math.min(BASE_FIRST_POLL_MS, Math.max(0, until - Date.now())), done);
    }
}

/** Waits ms, or less when early settles; never leaves a timer behind. */
async function waitOrSettled(ms: number, early: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), early]);
    clearTimeout(timer);
}

/**
 * Boots base and PR at the same time: both first rounds start together,
 * in a fixed order, so a resumed workflow replays the same steps; inside its
 * step the PR's first acquire is sent once the base's started (baseStarted). A lost cell
 * gets one more try per side, one side after the other; a second loss is `errored`.
 * A side that waited for room past the budget ends the Run `timed_out`, as a
 * Run that waited too long in the queue: nothing of it was tested or failed.
 * Each side's claim is kept leased as soon as it is bound (onBound), while
 * the other side may still wait for room.
 */
async function bootBoth(
    deps: RunDeps,
    req: RuntimeRunRequested,
    room: RoomBudget | undefined,
    onBound: (claim: Claim) => void,
    onFirst?: (first: { base: Promise<AcquireTry>; pr: Promise<AcquireTry> }) => void,
): Promise<Record<'base' | 'pr', Booted>> {
    const bound = (r: AcquireTry): AcquireTry => {
        if ('claim' in r && !isBlocked(r.claim)) onBound(r.claim);
        return r;
    };
    const base = tryAcquire(deps, req, 'base', 1, room).then(bound);
    const pr = tryAcquire(deps, req, 'pr', 1, room, () => baseStarted(deps, req, base)).then(bound);
    // Right after the two first acquires, in the same tick: a step it starts has a fixed place.
    onFirst?.({ base, pr });
    const first = await Promise.all([base, pr]);
    const out: Partial<Record<'base' | 'pr', Booted>> = {};
    for (const [i, side] of (['base', 'pr'] as const).entries()) {
        let r = first[i];
        if ('error' in r) r = bound(await tryAcquire(deps, req, side, 2, room));
        if ('error' in r) throw new RunAbort('errored', `cell lost twice while acquiring the ${side} machine: ${r.error}`);
        out[side] = r;
    }
    for (const side of ['base', 'pr'] as const) {
        const r = out[side]!;
        if (isCapacityWait(r.claim)) throw new RunAbort(room.noCapacityWait ? 'errored' : 'timed_out', room.noCapacityWait ? 'reserved capacity is unavailable; Run again' : capacityWaitReason(side, r.claim, r.waitedMs ?? 0));
    }
    return { base: out.base!, pr: out.pr! };
}

/**
 * A claim's machines are destroyed at its hardExpiresAt (60 min from its
 * acquire), whatever the renewals say. The Run's 45 min count from when both
 * sides had room (roomAt), so after a long wait for one side (over 15 min) the
 * side that booted first would be destroyed before the Run ends. That side is
 * given back and booted again on a fresh claim (a baked image or a pool
 * machine: seconds), whose ceiling covers the Run; its first boot still
 * stands for the boot times the Run reports. Only when both sides booted.
 */
async function renewShortLived(
    deps: RunDeps,
    req: RuntimeRunRequested,
    booted: Record<'base' | 'pr', Booted>,
    roomAt: string,
    room: RoomBudget,
    leases: RunLeaseHolds,
    beforeRelease?: (side: 'base' | 'pr') => Promise<void>,
): Promise<Record<'base' | 'pr', Booted>> {
    if (isBlocked(booted.base.claim) || isBlocked(booted.pr.claim)) return booted;
    const runEnd = Date.parse(roomAt) + RUN_TIMEOUT_MS;
    const out = { ...booted };
    for (const side of ['base', 'pr'] as const) {
        const first = out[side].claim as Claim;
        if (Date.parse(first.hardExpiresAt) >= runEnd) continue;
        if (room.noCapacityWait) throw new RunAbort('errored', 'reserved claims cannot cover this Run; Run again');
        await beforeRelease?.(side);
        leases.drop(first.claimId);
        await deps.step(`release:${side}:short-lived`, async () => {
            await deps.env.release(first.claimId).catch((e) => deps.onReleaseFailed?.(first.claimId, e as Error));
            deps.log?.info({ msg: 'run.claim.renewed', runId: req.runId, side, claimId: first.claimId, hardExpiresAt: first.hardExpiresAt, runEndsAt: new Date(runEnd).toISOString() });
        });
        const r = await tryAcquire(deps, req, side, 'renewed', room);
        if ('error' in r) throw new RunAbort('errored', `cell lost while booting the ${side} machine again: ${r.error}`);
        if (isCapacityWait(r.claim)) throw new RunAbort('timed_out', capacityWaitReason(side, r.claim, r.waitedMs ?? 0));
        if (isBlocked(r.claim)) throw new RunAbort('errored', `the ${side} machine could not boot again: ${r.claim.blockers.map((b) => `${b.kind}:${b.signature}`).join(', ')}`);
        leases.add(r.claim.claimId);
        if (r.waitedMs) await deps.step(`booting:room:${side}:renewed`, async () => deps.projection.upsert(req.runId, { phase: 'booting', capacityWait: null }));
        const { roundSnapshotId: _old, ...kept } = out[side];
        out[side] = { ...kept, claim: { ...r.claim, ...(first.timing ? { timing: first.timing } : {}) }, ...(r.roundSnapshotId ? { roundSnapshotId: r.roundSnapshotId } : {}) };
    }
    return out;
}

/**
 * Where a Run's wait for room shows: the projection's phase is
 * `capacity` with what the cell said (memory needed and free, claims ahead),
 * and one `phase` event per side when it starts waiting.
 */
function roomBudget(deps: RunDeps, req: RuntimeRunRequested, started: { at: string; waited: number }, noCapacityWait = false): RoomBudget {
    const announced = new Set<string>();
    return {
        noCapacityWait,
        // What is left of the Run's queue budget: a Run never waits for room longer than it may wait in the queue.
        until: Date.parse(started.at) + Math.max(0, QUEUE_TIMEOUT_MS - started.waited),
        onWait: async (side, w) => {
            const at = deps.now().toISOString();
            const b = w.blocked.blockers[0];
            const capacityWait = {
                side,
                since: new Date(Date.parse(at) - w.waitedMs).toISOString(),
                // The last refusal: the sweeper counts the Run's 45 min from no earlier than this.
                at,
                signature: b?.signature ?? 'no_capacity',
                message: (b?.message ?? '').slice(0, 300),
                ...(w.blocked.capacity ?? {}),
            };
            await deps.projection.upsert(req.runId, { phase: 'capacity', capacityWait });
            if (announced.has(side)) return;
            announced.add(side);
            await deps.events.append(req.organizationId, req.runId, { type: 'phase', at, data: { phase: 'capacity', ...capacityWait } }, `${req.attempt}:phase:capacity:${side}`);
        },
    };
}

/** Releases the Run's claims through the hub; a failed release is reported and left to the reaper. */
export async function releaseClaims(deps: RunDeps, runId: string): Promise<void> {
    await deps.step('claims:release', async () => {
        for (const c of await deps.claims.forRun(runId)) {
            await deps.env.release(c.claimId).catch((e) => deps.onReleaseFailed?.(c.claimId, e as Error));
        }
    });
}

/** What the Run learned on the way, for the structured report (product screen 7). */
export interface PublishContext {
    steps: GateStep[];
    bootMs?: number;
    blockedOutbound?: Array<{ host: string; port?: number }>;
    dependencyChangeUntested?: boolean;
    stoppedEarly?: boolean;
    /** The cell reported one side's code exfiltrating: the Run halts as a failing check. */
    securityViolation?: SecurityViolation;
}

export async function publish(
    deps: PublishDeps,
    req: Pick<RuntimeRunRequested, 'runId' | 'attempt' | 'organizationId' | 'correlationId'> &
        Partial<Pick<RuntimeRunRequested, 'requestedAt' | 'trigger'>> & { headSha: string },
    state: RunState,
    verdict?: VerdictOutcome | { verdictState: 'could_not_boot' },
    reason?: string,
    /** The Run's canaries: nothing published may carry one. */
    canaries: Canary[] = [],
    ctx: PublishContext = { steps: [] },
): Promise<string[]> {
    return deps.step('publish', async (): Promise<string[]> => {
        const at = deps.now().toISOString();
        const computed = checkConclusionFor(state, verdict as any, reason, { securityViolation: !!ctx.securityViolation });
        const check = { ...computed, title: redactCanaries(computed.title, canaries) };
        await deps.projection.upsert(req.runId, { publishStartedAt: at, check });
        // Simulation and external verification have no publication authority or product target.
        if (req.trigger === 'simulate' || req.trigger === 'external_finding') {
            await deps.events.append(req.organizationId, req.runId, { type: 'published', at, data: { conclusion: check.conclusion, title: check.title, ...(req.trigger === 'simulate' ? { simulated: true } : { verificationOnly: true }) } }, `${req.attempt}:published`);
            return [];
        }
        const current = await deps.projection.get(req.runId);
        // Always the structured report: the publisher refuses free text. A stopped
        // Run has no request at hand; its projection says when it was requested.
        const requestedAt = req.requestedAt ?? current?.requestedAt ?? at;
        const report = redactDeep(
                  buildReport({
                      req: { requestedAt, trigger: req.trigger, headSha: req.headSha },
                      state,
                      verdictState: verdict?.verdictState ?? current?.verdictState,
                      probes: current?.probes ?? [],
                      steps: ctx.steps,
                      uncovered: current?.uncoveredEntryPoints ?? [],
                      blockedOutbound: ctx.blockedOutbound,
                      dependencyChangeUntested: ctx.dependencyChangeUntested,
                      bootMs: ctx.bootMs,
                      commands: ctx.steps.length || undefined,
                      cellOwner: current?.cellOwner,
                      securityEvent: state === 'halted' && !ctx.securityViolation,
                      securityViolation: ctx.securityViolation,
                      stoppedEarly: ctx.stoppedEarly,
                      recipeChangedInPr: current?.recipeChangedInPr,
                      recipeChangedInMember: current?.recipeChangedInMember,
                      uncoveredDetail: current?.uncovered,
                      bootFailure: current?.bootFailure,
                      noRuntimeEffect: current?.noRuntimeEffect,
                      coldBuild: current?.coldBuild,
                  }),
                  canaries,
              );
        const summary = redactCanaries(
            verdict && 'findings' in verdict
                ? buildComment({
                      check,
                      findings: verdict.findings,
                      intended: verdict.intendedFindings,
                      uncovered: verdict.uncoveredEntryPoints,
                      probes: (await deps.projection.get(req.runId))?.probes ?? [],
                      headSha: req.headSha,
                      securityEvent: state === 'halted',
                      recipeChangedInPr: current?.recipeChangedInPr,
                      recipeChangedInMember: current?.recipeChangedInMember,
                  })
                : `### Kody Runtime · ${check.title}`,
            canaries,
        );
        await deps.publisher.request({
            runId: req.runId,
            attempt: req.attempt,
            kind: 'check',
            key: publishKey(req.runId, req.attempt, 'check'),
            correlationId: req.correlationId,
            check: { status: 'completed', conclusion: check.conclusion, title: check.title, summary },
            report,
        });
        // superseded and cancelled close the check without a new comment.
        if (state !== 'superseded' && state !== 'cancelled') {
            await deps.publisher.request({
                runId: req.runId,
                attempt: req.attempt,
                kind: 'comment',
                key: publishKey(req.runId, req.attempt, 'comment'),
                correlationId: req.correlationId,
                // The product renders the comment from the report; the text is the fallback.
                report,
            });
        }
        const published = ['check', ...(state !== 'superseded' && state !== 'cancelled' ? ['comment'] : [])];
        await deps.projection.upsert(req.runId, { published });
        await deps.events.append(req.organizationId, req.runId, { type: 'published', at, data: { conclusion: check.conclusion, title: check.title } }, `${req.attempt}:published`);
        return published;
    });
}

/**
 * The check a fork shows while it waits for a maintainer: check only, under its own key
 * `runId:attempt:check:awaiting_approval`. It does not mark publishing as started, so a stop
 * still finalizes the Run, and the final verdict moves the same check run with `runId:attempt:check`.
 */
async function publishAwaitingApproval(deps: PublishDeps, req: RuntimeRunRequested): Promise<void> {
    if (req.trigger === 'external_finding') return;
    await deps.step('publish:awaiting_approval', async () => {
        const check = checkConclusionFor('awaiting_approval');
        const report = buildReport({
            req: { requestedAt: req.requestedAt, trigger: req.trigger, headSha: req.pullRequest.headSha },
            state: 'awaiting_approval',
            probes: [],
            steps: [],
            uncovered: [],
        });
        await deps.publisher.request({
            runId: req.runId,
            attempt: req.attempt,
            kind: 'check',
            key: publishKey(req.runId, req.attempt, 'check', 'awaiting_approval'),
            correlationId: req.correlationId,
            check: { status: 'completed', conclusion: check.conclusion, title: check.title, summary: `### Kody Runtime · ${check.title}` },
            report,
        });
        await deps.events.append(
            req.organizationId,
            req.runId,
            { type: 'published', at: deps.now().toISOString(), data: { kind: 'check', phase: 'awaiting_approval', conclusion: check.conclusion, title: check.title } },
            `${req.attempt}:published:awaiting_approval`,
        );
    });
}

/** Where the canary was seen goes to the projection, the stream and a metric; the value never does. */
/** The cell reported exfiltration on one side's claim: projection, stream and metric name the side and the alert kind, never the host. */
async function securityViolationEvent(deps: RunDeps, req: RuntimeRunRequested, v: SecurityViolation): Promise<void> {
    await deps.step('security:violation', async () => {
        const at = deps.now().toISOString();
        await deps.projection.upsert(req.runId, { securityEvent: { kind: 'exfiltration', where: v.side, signature: v.signature, at } });
        await deps.events.append(req.organizationId, req.runId, { type: 'security', at, data: { kind: 'exfiltration', side: v.side, signature: v.signature } }, `${req.attempt}:security:violation`);
        deps.metrics.recordSecurityEvent({ orgId: req.organizationId, kind: 'exfiltration', where: v.side });
    });
}

async function securityEvent(deps: RunDeps, req: RuntimeRunRequested, where: LeakSite): Promise<void> {
    await deps.step('security', async () => {
        const at = deps.now().toISOString();
        await deps.projection.upsert(req.runId, { securityEvent: { kind: 'canary', where, at } });
        await deps.events.append(req.organizationId, req.runId, { type: 'security', at, data: { kind: 'canary', where } }, `${req.attempt}:security`);
        deps.metrics.recordSecurityEvent({ orgId: req.organizationId, kind: 'canary', where });
    });
}

async function phase(deps: RunDeps, req: RuntimeRunRequested, name: string, data: Record<string, unknown> = {}) {
    await deps.step(`phase:${name}`, async () => {
        const at = deps.now().toISOString();
        await deps.projection.upsert(req.runId, { phase: name });
        await deps.events.append(req.organizationId, req.runId, { type: 'phase', at, data: { phase: name, ...data } }, `${req.attempt}:phase:${name}`);
    });
}

/**
 * The PR comment while the Run works (product screen 6): one publish per phase,
 * under `runId:attempt:comment:<phase>`, editing the same comment. Best effort:
 * a failed progress update never fails the Run, and a simulation posts nothing.
 */
async function progress(
    deps: RunDeps,
    req: RuntimeRunRequested,
    startedAt: string,
    phase: CommentPhase,
    data: { bootMs?: number; applyMs?: number; tested?: { done: number; total: number }; regressions?: number; estimates?: PhaseEstimates } = {},
): Promise<void> {
    if (req.trigger === 'simulate' || req.trigger === 'external_finding') return;
    await deps.step(`publish:progress:${phase}`, async () => {
        await deps.publisher
            .request({
                runId: req.runId,
                attempt: req.attempt,
                kind: 'comment',
                key: publishKey(req.runId, req.attempt, 'comment', phase),
                correlationId: req.correlationId,
                progress: { phase, requestedAt: req.requestedAt, startedAt, ...(req.trigger ? { trigger: req.trigger } : {}), ...data },
            })
            .catch((e) => deps.log?.warn({ msg: 'run.progress_publish_failed', runId: req.runId, phase, error: safeFailure(e) }));
    });
}

/** A Run's evidence target: a write that fails is logged and counted, never silent. */
function runEvidence(deps: RunDeps, req: RuntimeRunRequested, kind: 'probe' | 'exploration' | 'test'): RunEvidence | undefined {
    if (!deps.evidence) return undefined;
    return {
        organizationId: req.organizationId,
        store: deps.evidence,
        ...(deps.evidenceUploads ? { uploads: deps.evidenceUploads } : {}),
        onError: (e) => {
            const err = e as { code?: unknown; name?: unknown } | undefined;
            const errorCode = typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : 'error';
            deps.log?.warn({ msg: 'evidence.write_failed', runId: req.runId, organizationId: req.organizationId, kind, errorCode });
            deps.metrics.recordEvidenceWriteFailed({ orgId: req.organizationId, kind });
        },
    };
}

/** Recent Run phase estimates are only needed when this Run posts progress. */
async function estimatesFor(deps: RunDeps, req: RuntimeRunRequested): Promise<PhaseEstimates | undefined> {
    if (req.trigger === 'simulate' || req.trigger === 'external_finding') return undefined;
    // Estimates only shape the progress comment: unreadable, the comment goes without them.
    return deps.step('estimates', async () =>
        phaseEstimates(deps.projection, { runId: req.runId, organizationId: req.organizationId, environmentId: req.environment.environmentId }).catch(() => undefined),
    );
}

export interface RunOptions {
    /** Internal admission wrapper only: already granted resources must not wait in execution. */
    noCapacityWait?: boolean;
    admissionRef?: import('../../shared/admission/admission-contract').AdmissionRef;
    /**
     * A fork PR runs only after a maintainer approved its head: the
     * approval gate workflow (RunEngineService) waits off the queue and sets this.
     */
    forkApproved?: boolean;
    /** When the Run entered the fair queue (the approval time for a fork); defaults to requestedAt. */
    queuedAt?: string;
}

/** A span around one part of the Run, under the Run's correlation id. */
type RunSpan = (name: string) => <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * What every phase of one Run shares: the request, its deps and what the Run
 * has learned so far (the publish context and the tally run.finished says).
 * Only step outputs fill it, so a replay rebuilds the same scope.
 */
interface RunScope {
    req: RuntimeRunRequested;
    deps: RunDeps;
    opts: RunOptions;
    span: RunSpan;
    startedAt: { at: string; waited: number };
    canaries: Canary[];
    ctx: PublishContext;
    tally: RunTally;
    /** Renewals of the Run's claims, from each side's boot until the Run ends (lease-keeper.ts). */
    leases: RunLeaseHolds;
    reportingAt?: number;
    /** The plan the agent makes while the PR side boots (early-plan.ts); absent once taken or dropped, or when the plan is given. */
    early?: { result: Promise<EarlyPlan>; abort: AbortController };
    /** The first base rounds played with that plan while the PR built (early-plan.ts), once the plan is taken. */
    firstBaseRounds?: FirstBaseRounds;
}

/** Both sides as their acquires answered, and how long each took from when both had room. */
interface BootedSides {
    booted: Record<'base' | 'pr', Booted>;
    base: Claim | Blocked;
    pr: Claim | Blocked;
    baseMs: number;
    applyMs: number;
}

/** Both sides up, on one pinned image: what the tests run against. */
interface ReadySides {
    base: Claim;
    pr: Claim;
    pinnedImageId: string;
    /** Each side's round snapshot (Booted.roundSnapshotId), which its resets name. */
    rounds: { base?: string; pr?: string };
    baseMs: number;
    applyMs: number;
}

/** What the test phase found; partial when a canary or a security violation stopped it early. */
interface TestedRun {
    entryPoints: ReturnType<typeof extractEntryPoints>;
    dependency: ReturnType<typeof extractEntryPoints>;
    verdictEntryPoints: string[];
    plan: AgentPlan;
    verdicts: ProbeVerdict[];
    allSteps: GateStep[];
    testRuns: TestRun[];
    classified: ProbeVerdict[];
    leak?: LeakSite;
    testingAt: number;
}

/** The step 'start' (when the Run left the queue) and the Run's canaries, derived again on every replay. */
async function startRun(req: RuntimeRunRequested, deps: RunDeps, opts: RunOptions, span: RunSpan): Promise<RunScope> {
    const startedAt = await deps.step('start', async () => {
        const now = deps.now();
        const waited = now.getTime() - Date.parse(opts.queuedAt ?? req.requestedAt);
        deps.metrics.recordQueueWait(waited, { orgId: req.organizationId, trigger: req.trigger });
        await deps.projection.upsert(req.runId, { startedAt: now.toISOString() });
        return { at: now.toISOString(), waited };
    });

    // The Run's canaries. Derived, not stored: the step records only which slots exist,
    // so the values never reach a DBOS checkpoint, the projection or the stream.
    await deps.step('canaries', async () => ({ slots: deps.canaries.forRun(req).map((c) => c.slot) }));
    const canaries = deps.canaries.forRun(req);
    return { req, deps, opts, span, startedAt, canaries, ctx: { steps: [] }, tally: newTally(), leases: new RunLeaseHolds(deps.leases) };
}

/** Why a side did not boot, for the Run page and one line of the comment: token patterns and canaries redacted. */
function bootFailureFor(run: RunScope, side: 'base' | 'pr', claim: Blocked, at: string): { bootFailure?: RunBootFailure } {
    const first = claim.blockers[0];
    if (!first) return {};
    const alias = blockerAliasOf(first);
    const fork = side === 'pr' && run.req.pullRequest.fork === true;
    return { bootFailure: bootFailureOf({ side, blocker: first, at, clean: (text) => redactCanaries(redactPatterns(text).text, run.canaries), ...(alias ? { alias } : {}), ...(fork ? { fork } : {}) }) };
}

/** Ends the Run: its final state, the check and the comment, the claims given back and run.finished. */
async function finishRun(run: RunScope, state: RunState, verdict?: VerdictOutcome | { verdictState: 'could_not_boot' }, rawReason?: string): Promise<RunResult> {
    const { deps, req, canaries, ctx, tally, startedAt } = run;
    run.leases.stop();
    const reason = rawReason === undefined ? undefined : redactCanaries(rawReason, canaries);
    const verdictState = verdict?.verdictState;
    const moved = await transition(deps, req, state, { ...(verdictState ? { verdictState } : {}), ...(reason ? { reason } : {}) });
    if (!moved) {
        const current = await deps.projection.get(req.runId);
        return { state: current?.state ?? state };
    }
    tally.published = (await publish(deps, { ...req, headSha: req.pullRequest.headSha }, state, verdict, reason, canaries, ctx)) ?? [];
    await releaseClaims(deps, req.runId);
    await deps.step('log:finished', async () => {
        const at = deps.now().getTime();
        // Inside the step, so a replayed Run never counts its duration twice.
        deps.metrics.recordRunDuration(at - Date.parse(startedAt.at), { orgId: req.organizationId, state, trigger: req.trigger });
        if (verdictState) deps.metrics.recordRunVerdict(verdictState, { orgId: req.organizationId, trigger: req.trigger });
        // The blocker the Run page shows (bootFailure), counted once with the Run's end.
        const failure = (await deps.projection.get(req.runId))?.bootFailure;
        if (failure) deps.metrics.recordBlocker(failure, { orgId: req.organizationId, consumer: 'runtime' });
        const reportMs = run.reportingAt === undefined ? undefined : at - run.reportingAt;
        if (reportMs !== undefined) deps.log?.info(phaseLine(req, 'reporting', reportMs));
        deps.log?.info(finishedLine(req, { state, verdictState, totalMs: at - Date.parse(startedAt.at) }, { ...tally, reportMs }));
    });
    const check = checkConclusionFor(state, verdict as any, reason, { securityViolation: !!ctx.securityViolation });
    return { state, verdictState, conclusion: check.conclusion, title: check.title };
}

/**
 * What ends a Run before anything boots, decided from the request alone: a
 * fork without an approval of this head, a PR whose every changed file is
 * a recipe file the claims replace with the base's (the PR side would boot as
 * main does, so nothing boots and the Run says so), or a PR whose every
 * change is a comment, layout or documentation by its parser
 * (nothing_to_test: no request reaches a change, so no machine is paid for).
 */
async function endBeforeBoot(run: RunScope, opts: { planGiven: boolean }): Promise<RunResult | undefined> {
    if (isForkApprovalRequired(run.req) && !run.opts.forkApproved) return finishRun(run, 'cancelled', undefined, 'fork PR without an approval');
    if (changesOnlyTheRecipe(run.req)) return finishRun(run, 'partly_tested', decideRunVerdict({ entryPoints: [], probes: [] }), 'the PR changes only the recipe, which the Run takes from the base');
    // Every changed file is a comment, layout or documentation change, by its parser: nothing a request reaches changed, so nothing boots.
    // A given plan (an external finding's) is tested as given.
    const unchanged = opts.planGiven ? undefined : noRuntimeEffectOf(run.req.diff, { recipe: recipeChangedInPr(run.req), truncated: run.req.diffTruncated });
    if (unchanged) {
        const { deps, req } = run;
        await deps.step('no-runtime-effect', async () => deps.projection.upsert(req.runId, { noRuntimeEffect: unchanged }));
        return finishRun(run, 'nothing_to_test', NOTHING_TO_TEST, `the PR changes nothing that runs: ${unchanged.map((f) => f.file).join(', ').slice(0, 400)}`);
    }
    // A member's PR the recipe boots nothing of: its routes would reach another repository's service. Nothing boots; its paths stay untested, and why.
    const notBooted = memberNotBootedOf(run.req);
    if (notBooted) {
        const { deps, req } = run;
        const ids = await deps.step('uncovered:member-not-booted', async () => {
            const ids = behaviorEntryPointIds(req);
            await deps.projection.upsert(req.runId, { uncoveredEntryPoints: ids, uncovered: uncoveredByMemberNotBooted(ids, notBooted) });
            return ids;
        });
        return finishRun(run, 'partly_tested', decideRunVerdict({ entryPoints: ids, probes: [] }), `the recipe does not boot ${notBooted}`);
    }
    return undefined;
}

/** booting: base and PR at the same time, the wait for room apart from boot time, and each side's boot phases. */
async function bootSides(run: RunScope, planEarly: boolean): Promise<BootedSides> {
    const { deps, req, startedAt, leases, tally, ctx, canaries } = run;
    const bootingAt = await deps.step('booting:at', async () => deps.now().toISOString());
    await transition(deps, req, 'booting', { bootingAt });
    const estimates = await estimatesFor(deps, req);
    await progress(deps, req, startedAt.at, 'booting', estimates ? { estimates } : {});
    const room = roomBudget(deps, req, startedAt, run.opts.noCapacityWait);
    let mainUp: Promise<boolean> = Promise.resolve(false);
    const firstBoot = await run.span('runtime.run.boot')(() =>
        bootBoth(deps, req, room, (c) => leases.add(c.claimId), (first) => {
            if (planEarly) startEarlyPlan(run, first);
            mainUp = announceMainUp(run, first.base, bootingAt, estimates);
        }),
    );
    // A wait for room is not boot time: the machines' clock (and the 45 min limit) starts once both had room.
    const waitedMs = Math.max(firstBoot.base.waitedMs ?? 0, firstBoot.pr.waitedMs ?? 0);
    const roomAt = new Date(Date.parse(bootingAt) + waitedMs).toISOString();
    if (waitedMs > 0) {
        await deps.step('booting:room', async () => {
            await deps.projection.upsert(req.runId, { phase: 'booting', bootingAt: roomAt, capacityWait: null, capacityWaitMs: waitedMs });
            deps.log?.info(phaseLine(req, 'capacity', waitedMs));
        });
    }
    // A base given back for a fresh claim is not explored on by a plan still running: that plan stops here.
    const booted = await renewShortLived(deps, req, firstBoot, roomAt, room, leases, async (side) => {
        if (side === 'base') await stopEarlyPlan(run);
    });
    const base = booted.base.claim;
    const pr = booted.pr.claim;
    const baseMs = Math.max(0, Date.parse(booted.base.readyAt) - Date.parse(roomAt));
    const bootMs = Math.max(baseMs, Date.parse(booted.pr.readyAt) - Date.parse(roomAt));
    const applyMs = bootMs - baseMs;
    tally.bootMs = baseMs;
    if (!isBlocked(base)) tally.applyMs = applyMs;
    await deps.step('log:booted', async () => {
        deps.log?.info(phaseLine(req, 'booting', baseMs, { ready: !isBlocked(base) }));
        if (!isBlocked(base)) deps.log?.info(phaseLine(req, 'applying', applyMs, { ready: !isBlocked(pr) }));
    });
    // Said as soon as main was up (announceMainUp); here only when that did not happen.
    const announced = await mainUp;
    if (!isBlocked(base) && !announced) await progress(deps, req, startedAt.at, 'applying', { bootMs: baseMs, ...(estimates ? { estimates } : {}) });
    // "Booted in" on the comment only when both sides booted: a side the cell answered as blocked (a boot_timeout
    // after 30 min of a cold build, kr-calcom#2) never booted, whatever time it took to say so.
    if (!isBlocked(base) && !isBlocked(pr)) ctx.bootMs = bootMs;
    // The environment's time to ready (Environment Health p50/p90) counts only boots that finished.
    // Each side's boot phases as its cell measured them (claim.ready.timing), for the Run page.
    if (!isBlocked(base) && !isBlocked(pr)) {
        const bootTiming = { ...(base.timing ? { base: phasesOf(base.timing) } : {}), ...(pr.timing ? { pr: phasesOf(pr.timing) } : {}) };
        // Where each side's builds spent their time, from a cell whose hub accepted the steps.
        const buildSteps = [buildStepsOf('base', base.timing, canaries), buildStepsOf('pr', pr.timing, canaries)].filter((b) => b !== undefined);
        tally.buildSteps = buildSteps;
        await deps.step('boot:time', async () =>
            deps.projection.upsert(req.runId, {
                bootMs,
                phaseMs: { boot: baseMs, apply: applyMs },
                ...(base.timing || pr.timing ? { bootTiming } : {}),
                ...(buildSteps.length ? { buildSteps } : {}),
                ...coldBuildOf({ base, pr }),
            }),
        );
    }
    return { booted, base, pr, baseMs, applyMs };
}

/**
 * The side whose builds ran with no cache because its cell had evicted the
 * environment's build state (the hub's Claim/Blocked buildStateEvictedAt),
 * the PR's first: the comment says a new setup restores it, instead of a slow
 * pull request or a machine out of resources.
 */
function coldBuildOf(sides: { base: Claim | Blocked; pr: Claim | Blocked }): { coldBuild?: { side: 'base' | 'pr'; cause: 'build_state_evicted'; evictedAt: string } } {
    for (const side of ['pr', 'base'] as const) {
        const at = sides[side].buildStateEvictedAt;
        if (at) return { coldBuild: { side, cause: 'build_state_evicted', evictedAt: at } };
    }
    return {};
}

/** The behavior entry points of the diff (never a dependency surface): what a Run that tests nothing leaves untested. */
const behaviorEntryPointIds = (req: RuntimeRunRequested) =>
    extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) })
        .filter((e) => e.kind !== 'dependency_surface')
        .map((e) => e.id);

/**
 * Every behavior entry point of the diff stays untested, and the page and the
 * comment name why: the boot blocker's kind and, for missing_env, the variable
 * (never a value).
 */
async function couldNotBoot(run: RunScope, booted: BootedSides, blocked: Blocked): Promise<RunResult> {
    const { deps, req } = run;
    await deps.step('uncovered:boot', async () => {
        const ids = behaviorEntryPointIds(req);
        await deps.projection.upsert(req.runId, {
            uncoveredEntryPoints: ids,
            uncovered: uncoveredByBoot(ids, bootBlockerOf(blocked.blockers, blocked.buildStateEvictedAt)),
            ...bootFailureFor(run, 'base', blocked, booted.booted.base.readyAt),
            ...coldBuildOf(booted),
        });
    });
    return finishRun(run, 'could_not_boot', { verdictState: 'could_not_boot' }, blocked.blockers.map((b) => `${b.kind}:${b.signature}`).join(', '));
}

/**
 * What the boot decided: both sides up on one pinned image, or the Run's end.
 * A claim the cell saw exfiltrate during the boot halts the Run (not
 * could_not_boot); a base that did not boot is could_not_boot; a PR the cell
 * could not start is partly tested, never a finding; a PR that does not boot
 * while the base does is a regression.
 */
async function settleBoot(run: RunScope, b: BootedSides): Promise<ReadySides | { finished: RunResult }> {
    const { deps, req, ctx } = run;
    const { booted, base, pr } = b;
    // No test runs: a plan made while the PR booted is never used, and what it spent shows on the Run.
    if (isBlocked(base) || isBlocked(pr)) await dropEarlyPlan(run);
    const bootViolation = (['base', 'pr'] as const)
        .map((side) => ({ side, b: booted[side].claim }))
        .map(({ side, b }) => (isBlocked(b) ? { side, blocker: b.blockers.find((x) => x.kind === 'security_violation') } : { side, blocker: undefined }))
        .find((x) => x.blocker);
    if (bootViolation?.blocker) {
        ctx.securityViolation = { side: bootViolation.side, signature: bootViolation.blocker.signature };
        await securityViolationEvent(deps, req, ctx.securityViolation);
        return { finished: await finishRun(run, 'halted', undefined, `security violation on the ${bootViolation.side} claim`) };
    }
    if (isBlocked(base)) return { finished: await couldNotBoot(run, b, base) };
    if (isBlocked(pr) && infraBootBlocker(pr.blockers)) {
        // The cell, not the PR: out of memory or disk while builds share the cell, or a
        // platform fault. Never a finding against the PR; its paths stay untested, and why.
        const blocker = bootBlockerOf(pr.blockers, pr.buildStateEvictedAt);
        const ids = await deps.step('uncovered:pr-boot', async () => {
            const ids = behaviorEntryPointIds(req);
            await deps.projection.upsert(req.runId, { uncoveredEntryPoints: ids, uncovered: uncoveredByBoot(ids, blocker), ...bootFailureFor(run, 'pr', pr, booted.pr.readyAt), ...coldBuildOf(b) });
            return ids;
        });
        return {
            finished: await finishRun(
                run,
                'partly_tested',
                decideRunVerdict({ entryPoints: ids, probes: [] }),
                `the cell could not start the PR's machine (${pr.blockers.map((x) => `${x.kind}:${x.signature}`).join(', ')}); not attributed to the PR`,
            ),
        };
    }
    if (isBlocked(pr)) {
        const boot: ProbeVerdict = {
            probeId: 'boot',
            entryPoint: 'boot',
            verdict: 'finding',
            findingKind: 'pr_destabilizes_machine',
            reason: `the PR does not boot while the base does: ${pr.blockers.map((x) => x.signature).join(', ')}`,
        };
        const v = decideRunVerdict({ entryPoints: ['boot'], probes: [boot] });
        await deps.step('verdict:boot', async () => deps.projection.upsert(req.runId, { probes: [boot], findings: [boot], ...bootFailureFor(run, 'pr', pr, booted.pr.readyAt) }));
        return { finished: await finishRun(run, 'regression', v) };
    }
    // The cell holds no bake of the environment: the setup has to run again there.
    if (unresolvedImage(base) && unresolvedImage(pr)) return { finished: await couldNotBoot(run, b, { status: 'blocked', blockers: [{ ...ENVIRONMENT_NOT_PREPARED }], cellId: base.cellId }) };
    // Both final acquire outputs are durable: recovery derives the same pin before any LLM or probe.
    const pinnedImageId = acquiredImagePin(req.environment.imageId, base, pr);
    await deps.step('image:pin', async () => deps.projection.upsert(req.runId, { imageId: pinnedImageId }));
    // Both claims are bound and kept leased since each one's boot (bootBoth), never past their hard ceiling.
    await deps.step('cell-owner', async () => deps.projection.upsert(req.runId, { cellOwner: base.cellOwner }));
    const rounds = { ...(booted.base.roundSnapshotId ? { base: booted.base.roundSnapshotId } : {}), ...(booted.pr.roundSnapshotId ? { pr: booted.pr.roundSnapshotId } : {}) };
    return { base, pr, pinnedImageId, rounds, baseMs: b.baseMs, applyMs: b.applyMs };
}

/** The agent's plan (or the external finding's), once both claims are still alive. */
async function planProbes(
    run: RunScope,
    ready: ReadySides,
    behavior: TestedRun['entryPoints'],
    providedPlan: AgentPlan | undefined,
    securityOf: (claimId: string) => Promise<string | undefined>,
): Promise<AgentPlan> {
    const { deps, req, tally } = run;
    const { base, pr } = ready;
    await phase(deps, req, 'agent', { entryPoints: behavior.map((e) => e.id) });
    // The plan made while the PR booted, when there is one; else planned now, as before.
    const early = run.early;
    run.early = undefined;
    const made = early ? await early.result : undefined;
    if (made?.kind === 'planned' && made.firstBaseRounds) run.firstBaseRounds = made.firstBaseRounds;
    const planned =
        made?.kind === 'planned'
            ? made.plan
            : await run.span('runtime.run.agent')(() =>
                  deps.step('agent:plan', async (): Promise<AgentPlan | ClaimLeaseFailed> => {
                      for (const side of ['base', 'pr'] as const) {
                          const claimFailure = await checkClaimLease(deps.env, side === 'base' ? base.claimId : pr.claimId, 'runtime', { side, securityOf });
                          if (claimFailure) return { claimFailure };
                      }
                      if (providedPlan) return providedPlan;
                      return planOrReuse(run, behavior, () => deps.agent.plan(agentPlanInput(run, base, behavior, deps.cancellationSignal?.())));
                  }),
              );
    if ('claimFailure' in planned) throwClaimLeaseFailure(planned.claimFailure);
    // The marker survives DBOS JSON checkpoint recovery; throw outside its step.
    if (planned.securityViolation) throw new SecurityViolationError(planned.securityViolation.side, planned.securityViolation.signature);
    const exploration = planned.exploration ?? [];
    addTokens(tally, planned.usage);
    tally.probesPlanned = planned.probes.length;
    tally.explored = planned.explored;
    tally.exploreFailed = exploration.filter((c) => c.failed).length;
    if (exploration.length) await deps.step('agent:exploration', async () => deps.projection.upsert(req.runId, { exploration }));
    return planned;
}

/**
 * The Run's plan: an earlier Run's accepted plan for the same head, base,
 * environment, entry points and planner version (plan-reuse.ts), else a new
 * one, keyed so a later Run can take it. Inside the plan step, so a resumed
 * workflow reads what it chose.
 */
async function planOrReuse(run: RunScope, behavior: TestedRun['entryPoints'], make: () => Promise<AgentPlan>): Promise<AgentPlan> {
    const { deps, req } = run;
    const key = planReuseKey({
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        entryPoints: behavior.map((e) => e.id),
        targets: req.environment.expose,
        plannerVersion: TEST_PLANNER_VERSION,
    });
    const past = deps.pastPlans
        ? await deps.pastPlans
              .find({ organizationId: req.organizationId, repositoryId: req.repository.id, prNumber: req.pullRequest.number, runId: req.runId, headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId, key })
              .catch((e: Error) => {
                  deps.log?.warn({ msg: 'run.plan.reuse_failed', runId: req.runId, error: e.message });
                  return undefined;
              })
        : undefined;
    if (past) {
        deps.log?.info({ msg: 'run.plan.reused', runId: req.runId, from: past.runId, probes: past.plan.probes.length });
        // The plan only: what its Run explored, spent or saw on base stays that Run's.
        const { exploration: _e, browserExploration: _b, recon: _r, usage: _u, ...plan } = past.plan;
        return { ...plan, explored: 0, exploration: [], usage: { inputTokens: 0, outputTokens: 0 }, reuseKey: key, plannerVersion: TEST_PLANNER_VERSION, reusedFrom: past.runId };
    }
    const made = await make();
    return { ...made, reuseKey: key, plannerVersion: TEST_PLANNER_VERSION };
}

/** What the agent plans from: the diff, the base machine it may explore, the Run's canaries and evidence. */
function agentPlanInput(run: RunScope, base: Claim, behavior: TestedRun['entryPoints'], signal: AbortSignal | undefined): Parameters<RunDeps['agent']['plan']>[0] {
    const { deps, req, canaries } = run;
    return {
        signal,
        runId: req.runId,
        attempt: req.attempt,
        organizationId: req.organizationId,
        runToken: req.runToken,
        entryPoints: behavior,
        diffSummary: req.diff.map((d) => `--- ${d.path}\n${d.patch}`).join('\n'),
        files: req.diff.flatMap((d) => (d.content ? [{ path: d.path, content: d.content }] : [])),
        baseClaimId: base.claimId,
        canaries,
        ...(base.capabilities ? { baseCapabilities: base.capabilities } : {}),
        targets: req.environment.expose,
        ...(deps.evidence ? { evidence: { ...runEvidence(deps, req, 'exploration')!, canaries } } : {}),
    };
}

const firstSide = (r: AcquireTry): FirstSide => ('claim' in r && !isBlocked(r.claim) ? { ready: r.claim } : {});

/**
 * The base claim's half of acquiredImagePin: a concrete image, the requested
 * one unless the Run asked for the latest. A base that fails it ends the Run
 * before any test (#2505), so nothing is planned on it early.
 */
const baseImagePinned = (requested: string, base: Claim) => {
    const imageId = base.manifest.imageId;
    return !!imageId?.trim() && imageId !== LATEST_IMAGE && (requested === LATEST_IMAGE || requested === imageId);
};

/**
 * Starts the plan made while the PR side boots (early-plan.ts): one step, at
 * its fixed place right after the two first acquires. The entry points are
 * the diff's, as testSides derives them.
 */
/**
 * The PR comment moves to "Started main" when main is up, not when both sides
 * are: a PR that builds for minutes left "Starting main and this pull request
 * … usually ~2 min" on the PR all that time (kr-kodus-ai#1).
 * Started in the same tick as the two first acquires (bootBoth's onFirst), so
 * the step has a fixed place; true when it published.
 */
function announceMainUp(run: RunScope, base: Promise<AcquireTry>, bootingAt: string, estimates: PhaseEstimates | undefined): Promise<boolean> {
    const { deps, req, startedAt } = run;
    if (req.trigger === 'simulate' || req.trigger === 'external_finding') return Promise.resolve(false);
    return deps
        .step('publish:progress:applying:main-up', async () => {
            const r = await base.catch(() => undefined);
            if (!r || !('claim' in r) || isBlocked(r.claim)) return false;
            const bootMs = Math.max(0, Date.parse(r.readyAt) - Date.parse(bootingAt) - (r.waitedMs ?? 0));
            await deps.publisher
                .request({
                    runId: req.runId,
                    attempt: req.attempt,
                    kind: 'comment',
                    key: publishKey(req.runId, req.attempt, 'comment', 'applying'),
                    correlationId: req.correlationId,
                    progress: { phase: 'applying', requestedAt: req.requestedAt, startedAt: startedAt.at, ...(req.trigger ? { trigger: req.trigger } : {}), bootMs, ...(estimates ? { estimates } : {}) },
                })
                .catch((e) => deps.log?.warn({ msg: 'run.progress_publish_failed', runId: req.runId, phase: 'applying', error: safeFailure(e) }));
            return true;
        })
        .catch(() => false);
}

function startEarlyPlan(run: RunScope, first: { base: Promise<AcquireTry>; pr: Promise<AcquireTry> }): void {
    const { deps, req } = run;
    const abort = new AbortController();
    const behavior = extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) }).filter(
        (e) => e.kind !== 'dependency_surface',
    );
    const result = deps.step('agent:plan:early', () =>
        planWhileThePrBoots({
            // A thrown acquire (a cancellation, a lost cell) reaches the workflow through bootBoth; here it is no claim.
            base: first.base
                .then(firstSide)
                .then((b): FirstSide => (b.ready && baseImagePinned(req.environment.imageId, b.ready) ? b : {}))
                .catch((): FirstSide => ({})),
            pr: first.pr.then(firstSide).catch((): FirstSide => ({})),
            ...(deps.env.progress
                ? {
                      prBuildStarted: async () => {
                          // Progress is best effort: unreadable reads as "not started yet", so the plan waits for the next look.
                          const p = await deps.env.progress!({ organizationId: req.organizationId, idempotencyKey: acquireKey(req, 'pr') }).catch(() => null);
                          return !!p?.phases.some((x) => x.phase === 'compose');
                      },
                  }
                : {}),
            leasesHeld: async (base, pr) => {
                const securityOf = async (claimId: string) => (await deps.claims.securityViolations([claimId]))[0]?.signature;
                for (const [side, claim] of [['base', base], ['pr', pr]] as const) {
                    if (claim && (await checkClaimLease(deps.env, claim.claimId, 'runtime', { side, securityOf }))) return false;
                }
                return true;
            },
            plan: (base, signal) => {
                // Read inside the step: the workflow's cancellation is the running step's.
                const cancel = deps.cancellationSignal?.();
                return planOrReuse(run, behavior, () => deps.agent.plan(agentPlanInput(run, base, behavior, cancel ? AbortSignal.any([signal, cancel]) : signal)));
            },
            whileThePrBoots: (plan, base, prAnswered, signal) => baseAhead(run, first.base, plan, base, prAnswered, signal),
            signal: abort.signal,
        }),
    );
    // Awaited where it is taken or dropped; never an unhandled rejection meanwhile.
    result.catch(() => undefined);
    run.early = { result, abort };
}

/**
 * Each planned probe's first base round, in plan order, while the PR side has
 * not answered (early-plan.ts, review P1): on the base claim the early plan
 * explored, its image and its round snapshot, with the stepIds the replay
 * would give them. Stops at the first round the replay must play itself (a
 * claim that failed its lease check, a round that threw) and after a round
 * that halts the Run (a canary, a security violation), which the replay then
 * applies. The replay takes them only on that same claim, image and snapshot.
 */
async function baseAhead(run: RunScope, firstBase: Promise<AcquireTry>, plan: AgentPlan, base: Claim, prAnswered: () => boolean, signal: AbortSignal): Promise<FirstBaseRounds | undefined> {
    const { deps, req, canaries } = run;
    if (!plan.probes.length || !base.manifest.imageId) return undefined;
    const booted = await firstBase.catch(() => undefined);
    const roundSnapshotId = booted && 'claim' in booted ? booted.roundSnapshotId : undefined;
    const securityOf = async (claimId: string) => (await deps.claims.securityViolations([claimId]))[0]?.signature;
    const rounds: RoundOut[] = [];
    for (const [index, planned] of plan.probes.entries()) {
        if (signal.aborted || prAnswered()) break;
        let out: RoundOut;
        try {
            out = await playFirstBaseRound({
                run: { runId: req.runId, attempt: req.attempt },
                index,
                probe: planned.probe,
                assertions: planned.assertions,
                securityOf,
                baseClaimId: base.claimId,
                pinnedImageId: base.manifest.imageId,
                ...(roundSnapshotId ? { rounds: { base: roundSnapshotId } } : {}),
                env: deps.env,
                canaries,
                ...(req.environment.ready ? { ready: req.environment.ready } : {}),
                ...(deps.evidence ? { evidence: runEvidence(deps, req, 'probe') } : {}),
            });
        } catch {
            break;
        }
        if ('claimFailure' in out) break;
        rounds.push(out);
        if (out.leaked || out.violation) break;
    }
    deps.log?.info({ msg: 'run.replay.base_ahead', runId: req.runId, rounds: rounds.length, probes: plan.probes.length });
    return { claimId: base.claimId, imageId: base.manifest.imageId, ...(roundSnapshotId ? { roundSnapshotId } : {}), rounds };
}

const withFirstBaseRound = (out: RoundOut | undefined) => (out ? { firstBaseRound: out } : {});

/** A probe's first base round played ahead, when it ran on the claim, image and snapshot the replay uses. */
function firstBaseRoundOf(run: RunScope, ready: ReadySides, index: number): RoundOut | undefined {
    const ahead = run.firstBaseRounds;
    if (!ahead || ahead.claimId !== ready.base.claimId || ahead.imageId !== ready.pinnedImageId || ahead.roundSnapshotId !== ready.rounds.base) return undefined;
    return ahead.rounds[index];
}

/** Stops the plan made while the PR booted and waits for its step to end; its result, if it planned, stays usable. */
async function stopEarlyPlan(run: RunScope): Promise<void> {
    if (!run.early) return;
    run.early.abort.abort();
    // Waited for only; its failure, if any, reaches the Run where planProbes takes the result.
    await run.early.result.catch(() => undefined);
}

/**
 * The PR side will not be tested: the plan made while it booted is stopped,
 * and a plan it finished is recorded on the Run as unused, with its tokens,
 * so what the overlap cost is never hidden.
 */
async function dropEarlyPlan(run: RunScope): Promise<void> {
    const early = run.early;
    if (!early) return;
    run.early = undefined;
    early.abort.abort();
    // The PR side is not tested: a plan that failed has nothing to record, as one that was stopped.
    const made = await early.result.catch(() => undefined);
    if (made?.kind !== 'planned') return;
    const { deps, req, tally } = run;
    const usage = made.plan.usage ?? { inputTokens: 0, outputTokens: 0 };
    addTokens(tally, made.plan.usage);
    await deps.step('agent:plan:unused', async () => {
        const unusedPlan = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, probes: made.plan.probes.length };
        await deps.projection.upsert(req.runId, { unusedPlan });
        deps.log?.info({ msg: 'run.plan.unused', runId: req.runId, ...unusedPlan });
    });
}

/** Each planned probe on both sides, in plan order: its gate decision, and what it covered from the observer's request log. */
async function replayProbes(run: RunScope, ready: ReadySides, t: TestedRun, behavior: TestedRun['entryPoints'], securityOf: (claimId: string) => Promise<string | undefined>): Promise<void> {
    const { deps, req, canaries, ctx } = run;
    const { plan } = t;
    await phase(deps, req, 'replay', {
        probes: plan.probes.length,
        explored: plan.explored,
        exploreFailed: run.tally.exploreFailed,
        viaRoutes: plan.probes.filter((p) => p.via).length,
        cannotProve: plan.cannotProve.length,
    });
    ctx.steps = t.allSteps;
    // A changed file with no route of its own is tested through the route the agent says reaches it.
    t.verdictEntryPoints = entryPointsWithRoutes(behavior.map((e) => e.id), plan.probes);
    const diffRefFor = (entryPoint: string, via: string | undefined): Pick<ProbeVerdict, 'diffRef'> => {
        const diffRef = diffRefOf({ entryPoint, via, entryPoints: t.entryPoints, files: req.diff });
        return diffRef ? { diffRef } : {};
    };
    for (const [index, planned] of plan.probes.entries()) {
        const replayed = await run.span('runtime.run.replay')(() =>
            replayProbe({
                run: { runId: req.runId, attempt: req.attempt },
                index,
                probe: planned.probe,
                assertions: planned.assertions,
                securityOf,
                claims: { base: ready.base.claimId, pr: ready.pr.claimId },
                pinnedImageId: ready.pinnedImageId,
                rounds: ready.rounds,
                env: deps.env,
                step: deps.step,
                canaries,
                ...(req.environment.ready ? { ready: req.environment.ready } : {}),
                ...(deps.evidence ? { evidence: runEvidence(deps, req, 'probe') } : {}),
                ...withFirstBaseRound(firstBaseRoundOf(run, ready, index)),
            }),
        );
        const { steps, lanes, responseDiff } = replayed;
        t.allSteps.push(...steps);
        // What the probe covered comes from the observer's request log on both
        // sides, never from the label the agent wrote.
        const requestsOf = (side: 'base' | 'pr') => steps.filter((x) => x.side === side).flatMap((x) => x.requests ?? []);
        const entryPoint = coveredEntryPoint(planned.entryPoint, t.verdictEntryPoints, { base: requestsOf('base'), pr: requestsOf('pr') });
        // A route the diff adds that main answers as absent is new behavior, not a regression (decideNewEndpoint).
        const addedByDiff = t.entryPoints.some((e) => e.id === entryPoint && e.added === true);
        const added = decideNewEndpoint(replayed.decision, steps, { addedByDiff });
        // A difference the diff's own lines spell out is the PR's intended change, never a regression (decideIntendedChange).
        const decision = decideIntendedChange(added, steps, {
            diff: req.diff,
            ...(planned.probe.spec.kind === 'browser' ? { browserStepKinds: browserStepKindsOf(planned.probe.spec.steps) } : {}),
        });
        const intendedChange = decision.intendedChange?.map((c) => ({ ...c, base: redactPatterns(c.base).text, pr: redactPatterns(c.pr).text }));
        // What was sent, from the typed spec: shown on the comment and the page, never coverage.
        const exercised = exercisedOf(planned.probe.spec);
        t.verdicts.push({
            probeId: planned.probe.id,
            entryPoint,
            ...(exercised ? { exercised } : {}),
            ...(planned.via && entryPoint === planned.entryPoint ? { via: planned.via } : {}),
            verdict: decision.verdict,
            findingKind: decision.findingKind,
            // Every finding starts unintended; only the diff (above) or the intent classifier below can downgrade it.
            intent: decision.verdict === 'finding' ? (intendedChange ? 'intended' : 'unintended') : undefined,
            reason: intendedChange ? redactPatterns(decision.reason).text : decision.reason,
            ...(intendedChange ? { intendedChange } : {}),
            differingFields: decision.differingFields,
            baseStepIds: steps.filter((x) => x.side === 'base').map((x) => x.stepId),
            prStepIds: steps.filter((x) => x.side === 'pr').map((x) => x.stepId),
            ...(lanes ? { lanes } : {}),
            ...(responseDiff ? { responseDiff } : {}),
            ...diffRefFor(entryPoint, planned.via && entryPoint === planned.entryPoint ? planned.via : undefined),
        });
        deps.metrics.recordVerdict(decision.verdict, { orgId: req.organizationId });
    }
}

/** A finding the diff already explains is intended: no classifier turn is spent on it. */
const needsIntent = (v: ProbeVerdict) => v.verdict === 'finding' && v.intent !== 'intended';

/**
 * Intent: the repository tests the agent named run on both sides as internal
 * evidence, then each finding is classified apart from the agent. It only
 * downgrades. An external finding's plan is never classified: its findings
 * stay uncertain.
 */
async function classifyFindings(run: RunScope, ready: ReadySides, t: TestedRun, providedPlan: AgentPlan | undefined, securityOf: (claimId: string) => Promise<string | undefined>): Promise<void> {
    const { deps, req, canaries, tally } = run;
    const tests = t.plan.tests ?? [];
    if (tests.length) {
        t.testRuns = await runPlannedTests({
            securityOf,
            run: { runId: req.runId, attempt: req.attempt },
            tests,
            pinnedImageId: ready.pinnedImageId,
            rounds: ready.rounds,
            claims: { base: ready.base.claimId, pr: ready.pr.claimId },
            env: deps.env,
            step: deps.step,
            canaries,
            ...(deps.evidence ? { evidence: runEvidence(deps, req, 'test') } : {}),
        });
    }
    const { verdicts } = t;
    if (providedPlan) {
        t.classified = verdicts.map((v) => (v.verdict === 'finding' ? { ...v, intent: 'uncertain' as const } : v));
    } else if (verdicts.some(needsIntent)) {
        t.classified = await run.span('runtime.run.intent')(async () => {
            await phase(deps, req, 'intent', { findings: verdicts.filter(needsIntent).length, tests: t.testRuns.length });
            return classifyIntents({
                verdicts,
                ctx: {
                    runId: req.runId,
                    organizationId: req.organizationId,
                    runToken: req.runToken,
                    diff: req.diff.map((d) => ({ path: d.path, patch: d.patch })),
                    title: req.pullRequest.title,
                    description: req.pullRequest.description,
                    tests: t.testRuns,
                },
                classifier: deps.intent,
                step: deps.step,
                onUsage: (u) => addTokens(tally, u),
            });
        });
    }
}

/**
 * testing: plan, replay and classify. A canary crossing a boundary, or a
 * security violation the cell reported, halts the Run: no more probes and no
 * more LLM calls; the gate closes with the steps already recorded
 * (unverified points stay partly tested).
 */
async function testSides(run: RunScope, ready: ReadySides, providedPlan: AgentPlan | undefined): Promise<TestedRun> {
    const { deps, req, startedAt, ctx } = run;
    await transition(deps, req, 'testing');
    const testingAt = await deps.step('testing:at', async () => deps.now().getTime());
    await progress(deps, req, startedAt.at, 'testing', { bootMs: ready.baseMs, applyMs: ready.applyMs });
    const entryPoints = await deps.step('entry-points', async () =>
        extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) }),
    );
    const behavior = entryPoints.filter((e) => e.kind !== 'dependency_surface');
    const verdicts: ProbeVerdict[] = [];
    const t: TestedRun = {
        entryPoints,
        dependency: entryPoints.filter((e) => e.kind === 'dependency_surface'),
        verdictEntryPoints: behavior.map((e) => e.id),
        plan: { probes: [], tests: [], claims: [], rejected: [], cannotProve: [], explored: 0 },
        verdicts,
        allSteps: [],
        testRuns: [],
        classified: verdicts,
        testingAt,
    };
    const securityOf = async (claimId: string) => (await deps.claims.securityViolations([claimId]))[0]?.signature;
    try {
        t.plan = await planProbes(run, ready, behavior, providedPlan, securityOf);
        await replayProbes(run, ready, t, behavior, securityOf);
        await classifyFindings(run, ready, t, providedPlan, securityOf);
    } catch (e) {
        if (e instanceof SecurityViolationError) {
            ctx.securityViolation = { side: e.side, signature: e.signature };
        } else {
            const site = canaryLeakSite(e);
            if (!site) throw e;
            t.leak = site;
        }
        t.classified = verdicts;
    }
    return t;
}

/** reporting: the egress the cell blocked, the Run's verdict and reproduction, and its end. */
async function reportVerdict(run: RunScope, ready: ReadySides, t: TestedRun): Promise<RunResult> {
    const { deps, req, canaries, ctx, tally, startedAt } = run;
    const { base, pr } = ready;
    const { plan, verdicts, allSteps } = t;
    let leak = t.leak;
    const unverifiedClaims = markUnbackedClaims(plan.claims, allSteps).filter((c) => !c.backedByProbe);
    ctx.stoppedEarly = !!leak || !!ctx.securityViolation;
    tally.probesDecided = verdicts.filter((v) => v.verdict !== 'inconclusive').length;
    run.reportingAt = await deps.step('reporting:at', async () => {
        const at = deps.now().getTime();
        deps.log?.info(phaseLine(req, 'testing', at - t.testingAt, { probes: plan.probes.length, decided: tally.probesDecided ?? 0 }));
        return at;
    });
    tally.testMs = run.reportingAt - t.testingAt;
    await progress(deps, req, startedAt.at, 'reporting', {
        bootMs: ready.baseMs,
        applyMs: ready.applyMs,
        tested: { done: plan.probes.length, total: plan.probes.length },
        regressions: t.classified.filter((v) => v.verdict === 'finding' && v.intent !== 'intended' && !isNewEndpointError(v)).length,
    });

    const egress = await deps.step('egress', async () => {
        const hosts = await deps.claims.egressBlocked([base.claimId, pr.claimId]);
        // A violation the hub recorded between steps (no step of ours saw it) halts the Run too.
        const violations = await deps.claims.securityViolations([base.claimId, pr.claimId]);
        const v = violations[0];
        const violation = v ? { side: (v.claimId === pr.claimId ? 'pr' : 'base') as 'base' | 'pr', signature: v.signature } : undefined;
        return { hosts: redactDeep(hosts, canaries), leaked: containsCanary(JSON.stringify(hosts), canaries), ...(violation ? { violation } : {}) };
    });
    if (egress.leaked) leak ??= 'egress';
    if (egress.violation) ctx.securityViolation ??= egress.violation;
    ctx.blockedOutbound = egress.hosts.filter((e: { phase?: string }) => e.phase === 'test');
    // What the comment is built from must not carry a canary either.
    let probes = t.classified;
    if (containsCanary(JSON.stringify(probes), canaries)) {
        leak ??= 'publish';
        probes = redactDeep(probes, canaries);
    }
    ctx.dependencyChangeUntested = t.dependency.length > 0 && !verdicts.some((v) => t.dependency.some((d) => d.id === v.entryPoint));
    const verdict = decideRunVerdict({
        entryPoints: t.verdictEntryPoints,
        probes,
        blockedOutbound: egress.hosts.filter((e) => e.phase === 'test').length,
        dependencyChangeUntested: ctx.dependencyChangeUntested,
        // A diff the product cut is partly tested at best.
        diffTruncated: req.diffTruncated === true,
    });
    tally.findings = verdict.findings.length;
    if (ctx.securityViolation) await securityViolationEvent(deps, req, ctx.securityViolation);
    else if (leak) await securityEvent(deps, req, leak);
    // What a developer needs to see each finding on their own machine: the observer
    // probe as sent, secrets and canaries redacted, and the recipe's boot commands.
    const reproduction = reproductionFor({
        findings: verdict.findings,
        probes: plan.probes.map((p) => p.probe),
        observed: (f) => ({ ...withObserved('base', observedOf(allSteps, f.baseStepIds)), ...withObserved('pr', observedOf(allSteps, f.prStepIds)) }),
        expose: req.environment.expose,
        recipe: req.environment.recipe,
    });
    await deps.step('verdict', async () => {
        await deps.projection.upsert(req.runId, {
            probes,
            findings: verdict.findings,
            ...(reproduction ? { reproduction: redactDeep(reproduction, canaries) } : {}),
            uncoveredEntryPoints: verdict.uncoveredEntryPoints,
            uncovered: uncoveredOf(probes, verdict.uncoveredEntryPoints, ctx.stoppedEarly),
            verdictState: verdict.verdictState,
        });
        await deps.events.append(req.organizationId, req.runId, {
            type: 'verdict',
            at: deps.now().toISOString(),
            data: {
                verdictState: verdict.verdictState,
                findings: verdict.findings.length,
                intended: verdict.intendedFindings.length,
                tests: t.testRuns.length,
                uncovered: verdict.uncoveredEntryPoints,
                forcedNeutral: verdict.forcedNeutral,
                unverifiedClaims: unverifiedClaims.length,
                rejectedProbes: plan.rejected.length,
                // How many entry points the agent said it could not prove (its prose stays out of the PR).
                cannotProve: plan.cannotProve.length,
                // Why the agent's probes were refused (schema messages, no repository text).
                ...(plan.rejected.length ? { rejectedReasons: plan.rejected.slice(0, 5).map((r) => r.reason.slice(0, 200)) } : {}),
                ...(leak ? { halted: true } : {}),
            },
        });
    });
    // halted keeps the computed verdict in verdictState, and the check follows it.
    return finishRun(run, leak || ctx.securityViolation ? 'halted' : verdict.verdictState, verdict);
}

/**
 * The Run workflow's body: start, the checks before any boot, booting,
 * testing and reporting, each a function of its own. The step ids each phase
 * asks for, and their order, are the workflow's durable contract
 * (run-orchestrator.step-ids.spec.ts).
 */
export async function runRuntimeRun(req: RuntimeRunRequested, deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
    const span: RunSpan = (name) => (fn) =>
        withRunSpan(name, req.correlationId, runSpanAttributes(req), () => fn(), req.traceparent);
    return span('runtime.run')(async () => {
        const run = await startRun(req, deps, opts, span);
        if (run.startedAt.waited > QUEUE_TIMEOUT_MS) return finishRun(run, 'timed_out', undefined, '30 min in the queue');

        try {
            let providedPlan: AgentPlan | undefined;
            if (req.trigger === 'external_finding' || req.externalVerification) {
                try {
                    providedPlan = externalVerificationPlan(req);
                } catch {
                    throw new RunAbort('skipped', 'external verification metadata or targets are unsupported');
                }
            }
            const ended = await endBeforeBoot(run, { planGiven: !!providedPlan });
            if (ended) return ended;
            // A given plan (an external finding's) has nothing to make while the PR boots.
            const booted = await bootSides(run, !providedPlan);
            const ready = await settleBoot(run, booted);
            if ('finished' in ready) return ready.finished;
            const tested = await testSides(run, ready, providedPlan);
            return await reportVerdict(run, ready, tested);
        } catch (e) {
            if (isCancellation(e)) throw e;
            await dropEarlyPlan(run);
            if (e instanceof RunAbort) return finishRun(run, e.state, undefined, e.reason);
            if (e instanceof LlmBudgetExceededError || e instanceof LlmUnavailableError) return finishRun(run, 'errored', undefined, `LLM unavailable: ${e.message}`);
            return finishRun(run, 'errored', undefined, (e as Error)?.message ?? 'unknown error');
        } finally {
            // A cancellation (or a throw past finish) ends the renewals too.
            run.leases.stop();
            // Never a step left running past the workflow.
            await stopEarlyPlan(run);
        }
    });
}

/**
 * The approval gate of a fork PR, run by its own workflow off the
 * fair queue: a fork waiting days for a maintainer never holds a queue slot.
 * The Run to start (with the approval's fresh tokens) when this head is (or
 * becomes) approved; otherwise the Run ends
 * cancelled here.
 */
export async function awaitForkApproval(
    req: RuntimeRunRequested,
    deps: Pick<RunDeps, 'step' | 'projection' | 'events' | 'publisher' | 'metrics' | 'now'> & { approvals: ForkApprovals },
): Promise<{ approved: RuntimeRunRequested } | RunResult> {
    const approved = await deps.step('fork:approved?', () => deps.approvals.has(req.runId, req.pullRequest.headSha));
    if (approved) return { approved: req };
    const waiting = await transition(deps, req, 'awaiting_approval', { reason: 'fork PR: waiting for a maintainer' });
    if (waiting) await publishAwaitingApproval(deps, req);
    // The wait is not a step: DBOS.recv is durable by itself.
    const got = await deps.approvals.wait(req.runId);
    if (got && got.headSha === req.pullRequest.headSha) {
        await transition(deps, req, 'queued');
        // The approval's fresh tokens replace the ones that expired while the Run waited.
        if (!got.tokens) return { approved: req };
        // The approval's fresh tokens replace the Run's; an approval without a PR token drops the stale one.
        const { prRepoToken: _stale, ...rest } = req;
        // A multi-repository Run's other repositories get theirs too: none boots with a token that expired while it waited.
        return {
            approved: withMemberTokens(
                { ...rest, repoToken: got.tokens.repoToken, ...(got.tokens.prRepoToken ? { prRepoToken: got.tokens.prRepoToken } : {}), runToken: got.tokens.runToken },
                got.tokens,
            ),
        };
    }
    const reason = got ? 'approval for another head' : 'no approval';
    const moved = await transition(deps, req, 'cancelled', { reason });
    if (moved) await publish(deps, { ...req, headSha: req.pullRequest.headSha }, 'cancelled', undefined, reason);
    return { state: 'cancelled' };
}

/** Ends a Run the engine stopped (cancel, superseded, timeout): release, state, check. */
export async function finalizeStoppedRun(
    deps: RunDeps,
    run: { runId: string; attempt: number; organizationId: string; correlationId: string; headSha: string },
    state: 'superseded' | 'cancelled' | 'timed_out' | 'errored',
    reason: string,
): Promise<boolean> {
    const current = await deps.step('stopped:read', () => deps.projection.get(run.runId));
    if (!current || isTerminal(current.state) || current.publishStartedAt) return false;
    await releaseClaims(deps, run.runId);
    const moved = await transition(deps, run, state, { reason });
    if (!moved) return false;
    const published = (await publish(deps, run, state, undefined, reason)) ?? [];
    await deps.step('log:finished', async () => deps.log?.info(finishedLine(run, { state, verdictState: current.verdictState }, { ...newTally(), published })));
    return true;
}
