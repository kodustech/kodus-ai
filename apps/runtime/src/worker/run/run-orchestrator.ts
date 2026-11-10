import { coveredEntryPoint, diffRefOf, extractEntryPoints } from '@libs/runtime/entry-points';
import { exercisedOf } from '@libs/runtime/probe/exercised';
import { AcquireRequest, Blocked, Claim, isBlocked, isCapacityWait } from '@libs/runtime/environment';
import { GateStep, LATEST_IMAGE, markUnbackedClaims } from '@libs/runtime/gate';
import {
    canTransition,
    decideRunVerdict,
    checkConclusionFor,
    type CommentPhase,
    isForkApprovalRequired,
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
import { withRunSpan } from '@libs/runtime/telemetry';

import { LlmBudgetExceededError, LlmUnavailableError } from '../agent/llm-gateway';
import type { AgentPlan } from '../agent/runtime-agent';
import { Canary, canaryLeakSite, containsCanary, LeakSite, redactCanaries, redactDeep } from '../canary/canary';
import { acquireWaitingForRoom, capacityWaitReason } from '../env/capacity-wait';
import { classifyIntents } from '../intent/intent-classifier';
import { runPlannedTests, TestRun } from '../intent/test-runs';
import { buildComment } from './comment';
import { changesOnlyTheRecipe, recipeChangedInPr } from './recipe-change';
import type { ForkApprovals, RunDeps } from './ports';
import { RunLeaseHolds } from './lease-keeper';
import { checkClaimLease, type ClaimLeaseFailed, throwClaimLeaseFailure } from '../env/claim-liveness';
import { isCancellation } from '../workflow-cancellation';
import { type SecurityViolation, SecurityViolationError } from './security-violation';
import { replayProbe } from './replay';
import { externalVerificationPlan } from './external-verification';
import { bootBlockerOf, entryPointsWithRoutes, infraBootBlocker, uncoveredByBoot, uncoveredOf, buildReport, observedOf } from './report';
import { buildStepsOf, phasesOf } from './build-steps';
import { type PhaseEstimates, phaseEstimates } from './run-estimates';
import type { RunEvidence } from './run-evidence';
import { addTokens, finishedLine, newTally, phaseLine, type RunTally } from './run-log';

// The body of the Run workflow (docs §3, §4). Every transition and every
// side effect is one step, so DBOS resumes a Run from its last checkpoint.

export const QUEUE_TIMEOUT_MS = 30 * 60_000;
export const RUN_TIMEOUT_MS = 45 * 60_000;

export interface RunResult {
    state: RunState;
    verdictState?: VerdictState;
    conclusion?: string;
    title?: string;
}

/** @deprecated import from worker/workflow-cancellation. */
export { isCancellation } from '../workflow-cancellation';

class RunAbort extends Error {
    constructor(
        readonly state: RunState,
        readonly reason: string,
    ) {
        super(reason);
    }
}

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
    req: Pick<RuntimeRunRequested, 'runId' | 'organizationId'> & { attempt?: number },
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
        deps.metrics.recordRunState(to, { orgId: req.organizationId });
        return true;
    });
}

const withObserved = <S extends 'base' | 'pr'>(side: S, o: Observed | undefined) => (o ? ({ [side]: o } as Partial<Record<S, Observed>>) : {});

/** `renewed`: a second claim for a side whose first claim could not live to the Run's end (renewShortLived). */
function acquireRequest(req: RuntimeRunRequested, side: 'base' | 'pr', renewed = false, canaries: Canary[] = []): AcquireRequest {
    return {
        organizationId: req.organizationId,
        environmentId: req.environment.environmentId,
        runId: req.runId,
        imageId: req.environment.imageId,
        ref: { side, sha: side === 'pr' ? req.pullRequest.headSha : req.pullRequest.baseSha },
        consumer: 'runtime',
        idempotencyKey: `${req.runId}:${side}:${req.attempt}${renewed ? ':renewed' : ''}`,
        ...(req.environment.recipe ? { recipe: req.environment.recipe } : {}),
        ...(req.environment.size ? { size: req.environment.size } : {}),
        // Planted by the cell in both sides' workloads (ADR-043): a sighting anywhere halts the Run.
        ...(canaries.length ? { canaries: canaries.map((c) => ({ slot: c.slot, value: c.value })) } : {}),
    };
}

/** waitedMs: how long the side waited for room on a cell before its claim was answered (ADR-070). */
type Booted = { claim: Claim | Blocked; readyAt: string; waitedMs?: number };
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
 * inside the same step until it is admitted or the budget ends (ADR-070):
 * nothing started, so the step only returns once the cell answered.
 */
async function tryAcquire(deps: RunDeps, req: RuntimeRunRequested, side: 'base' | 'pr', attempt: number | 'renewed', room?: RoomBudget): Promise<AcquireTry> {
    // Derived again here, never a step's input or output: a DBOS checkpoint never holds a canary.
    const request = acquireRequest(req, side, attempt === 'renewed', deps.canaries.forRun(req));
    try {
        return await deps.step(`acquire:${side}:${attempt}`, async () => {
            if (!room || room.noCapacityWait) return { claim: await deps.env.acquire(request), readyAt: deps.now().toISOString() };
            const r = await acquireWaitingForRoom(deps.env, request, {
                until: room.until,
                now: deps.now,
                signal: deps.cancellationSignal?.(),
                ...(deps.sleep ? { sleep: deps.sleep } : {}),
                onWait: (w) => room.onWait(side, w),
            });
            return { claim: r.claim, readyAt: deps.now().toISOString(), ...(r.rounds > 1 ? { waitedMs: r.waitedMs } : {}) };
        });
    } catch (e) {
        if (isCancellation(e)) throw e;
        return { error: (e as Error)?.message ?? 'unknown error' };
    }
}

/**
 * Boots base and PR at the same time (§3): both first rounds start together,
 * in a fixed order, so a resumed workflow replays the same steps. A lost cell
 * gets one more try per side, one side after the other; a second loss is `errored`.
 * A side that waited for room past the budget ends the Run `timed_out`, as a
 * Run that waited too long in the queue: nothing of it was tested or failed.
 * Each side's claim is kept leased as soon as it is bound (onBound), while
 * the other side may still wait for room.
 */
async function bootBoth(deps: RunDeps, req: RuntimeRunRequested, room: RoomBudget | undefined, onBound: (claim: Claim) => void): Promise<Record<'base' | 'pr', Booted>> {
    const bound = (r: AcquireTry): AcquireTry => {
        if ('claim' in r && !isBlocked(r.claim)) onBound(r.claim);
        return r;
    };
    const first = await Promise.all([tryAcquire(deps, req, 'base', 1, room).then(bound), tryAcquire(deps, req, 'pr', 1, room).then(bound)]);
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
): Promise<Record<'base' | 'pr', Booted>> {
    if (isBlocked(booted.base.claim) || isBlocked(booted.pr.claim)) return booted;
    const runEnd = Date.parse(roomAt) + RUN_TIMEOUT_MS;
    const out = { ...booted };
    for (const side of ['base', 'pr'] as const) {
        const first = out[side].claim as Claim;
        if (Date.parse(first.hardExpiresAt) >= runEnd) continue;
        if (room.noCapacityWait) throw new RunAbort('errored', 'reserved claims cannot cover this Run; Run again');
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
        out[side] = { ...out[side], claim: { ...r.claim, ...(first.timing ? { timing: first.timing } : {}) } };
    }
    return out;
}

/**
 * Where a Run's wait for room shows (ADR-070): the projection's phase is
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
    /** The Run's canaries: nothing published may carry one (ADR-043). */
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
        // Always the structured report: the publisher refuses free text (ADR-052). A stopped
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
                      uncoveredDetail: current?.uncovered,
                      bootFailure: current?.bootFailure,
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
        // superseded and cancelled close the check without a new comment (§3).
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
 * The check a fork shows while it waits for a maintainer (§3): check only, under its own key
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

/** ADR-043: where the canary was seen goes to the projection, the stream and a metric; the value never does. */
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
            .catch(() => undefined);
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
    return deps.step('estimates', async () =>
        phaseEstimates(deps.projection, { runId: req.runId, organizationId: req.organizationId, environmentId: req.environment.environmentId }).catch(() => undefined),
    );
}

export interface RunOptions {
    /** Internal admission wrapper only: already granted resources must not wait in execution. */
    noCapacityWait?: boolean;
    admissionRef?: import('../../shared/admission-contract').AdmissionRef;
    /**
     * A fork PR runs only after a maintainer approved its head (ADR-030): the
     * approval gate workflow (RunEngineService) waits off the queue and sets this.
     */
    forkApproved?: boolean;
    /** When the Run entered the fair queue (the approval time for a fork); defaults to requestedAt. */
    queuedAt?: string;
}

export async function runRuntimeRun(req: RuntimeRunRequested, deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
    const span = (name: string) => <T>(fn: () => Promise<T>) =>
        withRunSpan(name, req.correlationId, { 'runtime.run.id': req.runId, 'runtime.org.id': req.organizationId }, () => fn());

    return span('runtime.run')(async () => {
        const startedAt = await deps.step('start', async () => {
            const now = deps.now();
            const waited = now.getTime() - Date.parse(opts.queuedAt ?? req.requestedAt);
            deps.metrics.recordQueueWait(waited, { orgId: req.organizationId });
            await deps.projection.upsert(req.runId, { startedAt: now.toISOString() });
            return { at: now.toISOString(), waited };
        });

        // The Run's canaries (ADR-043). Derived, not stored: the step records only which slots exist,
        // so the values never reach a DBOS checkpoint, the projection or the stream.
        await deps.step('canaries', async () => ({ slots: deps.canaries.forRun(req).map((c) => c.slot) }));
        const canaries = deps.canaries.forRun(req);
        // Why a side did not boot, for the Run page and one line of the comment: token patterns and canaries redacted.
        const bootFailureFor = (side: 'base' | 'pr', claim: Blocked, at: string): { bootFailure?: RunBootFailure } => {
            const first = claim.blockers[0];
            if (!first) return {};
            return { bootFailure: bootFailureOf({ side, blocker: first, at, clean: (text) => redactCanaries(redactPatterns(text).text, canaries) }) };
        };

        const ctx: PublishContext = { steps: [] };
        // What run.finished says; filled from step outputs only.
        const tally: RunTally = newTally();
        let reportingAt: number | undefined;
        // Renewals of the Run's claims, from each side's boot until the Run ends (lease-keeper.ts).
        const leases = new RunLeaseHolds(deps.leases);
        const finish = async (state: RunState, verdict?: VerdictOutcome | { verdictState: 'could_not_boot' }, rawReason?: string): Promise<RunResult> => {
            leases.stop();
            const reason = rawReason === undefined ? undefined : redactCanaries(rawReason, canaries);
            const verdictState = verdict?.verdictState;
            const moved = await transition(deps, req, state, { ...(verdictState ? { verdictState } : {}), ...(reason ? { reason } : {}) });
            if (!moved) {
                const current = await deps.projection.get(req.runId);
                return { state: current?.state ?? state };
            }
            tally.published = (await publish(deps, { ...req, headSha: req.pullRequest.headSha }, state, verdict, reason, canaries, ctx)) ?? [];
            await releaseClaims(deps, req.runId);
            deps.metrics.recordRunDuration(deps.now().getTime() - Date.parse(startedAt.at), { orgId: req.organizationId, state });
            await deps.step('log:finished', async () => {
                const at = deps.now().getTime();
                const reportMs = reportingAt === undefined ? undefined : at - reportingAt;
                if (reportMs !== undefined) deps.log?.info(phaseLine(req, 'reporting', reportMs));
                deps.log?.info(finishedLine(req, { state, verdictState, totalMs: at - Date.parse(startedAt.at) }, { ...tally, reportMs }));
            });
            const check = checkConclusionFor(state, verdict as any, reason, { securityViolation: !!ctx.securityViolation });
            return { state, verdictState, conclusion: check.conclusion, title: check.title };
        };

        if (startedAt.waited > QUEUE_TIMEOUT_MS) return finish('timed_out', undefined, '30 min in the queue');

        try {
            let providedPlan: AgentPlan | undefined;
            if (req.trigger === 'external_finding' || req.externalVerification) {
                try { providedPlan = externalVerificationPlan(req); } catch { throw new RunAbort('skipped', 'external verification metadata or targets are unsupported'); }
            }
            // Fork code never boots without a maintainer's approval of this head.
            if (isForkApprovalRequired(req) && !opts.forkApproved) return finish('cancelled', undefined, 'fork PR without an approval');
            // Every changed file is a recipe file the claims replace with the base's: the PR side would
            // boot as main does, so nothing boots and the Run says so (S-19). Decided from the request alone.
            if (changesOnlyTheRecipe(req)) return finish('partly_tested', decideRunVerdict({ entryPoints: [], probes: [] }), 'the PR changes only the recipe, which the Run takes from the base');

            // booting: base and PR at the same time
            const bootingAt = await deps.step('booting:at', async () => deps.now().toISOString());
            await transition(deps, req, 'booting', { bootingAt });
            const estimates = await estimatesFor(deps, req);
            await progress(deps, req, startedAt.at, 'booting', estimates ? { estimates } : {});
            const room = roomBudget(deps, req, startedAt, opts.noCapacityWait);
            const firstBoot = await span('runtime.run.boot')(() => bootBoth(deps, req, room, (c) => leases.add(c.claimId)));
            // A wait for room is not boot time: the machines' clock (and the 45 min limit) starts once both had room.
            const waitedMs = Math.max(firstBoot.base.waitedMs ?? 0, firstBoot.pr.waitedMs ?? 0);
            const roomAt = new Date(Date.parse(bootingAt) + waitedMs).toISOString();
            if (waitedMs > 0) {
                await deps.step('booting:room', async () => {
                    await deps.projection.upsert(req.runId, { phase: 'booting', bootingAt: roomAt, capacityWait: null, capacityWaitMs: waitedMs });
                    deps.log?.info(phaseLine(req, 'capacity', waitedMs));
                });
            }
            const booted = await renewShortLived(deps, req, firstBoot, roomAt, room, leases);
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
            if (!isBlocked(base)) await progress(deps, req, startedAt.at, 'applying', { bootMs: baseMs, ...(estimates ? { estimates } : {}) });
            ctx.bootMs = bootMs;
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
                    }),
                );
            }
            // A claim the cell saw exfiltrate during the boot halts the Run (not could_not_boot).
            const bootViolation = (['base', 'pr'] as const)
                .map((side) => ({ side, b: booted[side].claim }))
                .map(({ side, b }) => (isBlocked(b) ? { side, blocker: b.blockers.find((x) => x.kind === 'security_violation') } : { side, blocker: undefined }))
                .find((x) => x.blocker);
            if (bootViolation?.blocker) {
                ctx.securityViolation = { side: bootViolation.side, signature: bootViolation.blocker.signature };
                await securityViolationEvent(deps, req, ctx.securityViolation);
                return finish('halted', undefined, `security violation on the ${bootViolation.side} claim`);
            }
            if (isBlocked(base)) {
                // Every behavior entry point of the diff stays untested, and the page and the comment
                // name why: the boot blocker's kind and, for missing_env, the variable (never a value).
                await deps.step('uncovered:boot', async () => {
                    const ids = extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) })
                        .filter((e) => e.kind !== 'dependency_surface')
                        .map((e) => e.id);
                    await deps.projection.upsert(req.runId, {
                        uncoveredEntryPoints: ids,
                        uncovered: uncoveredByBoot(ids, bootBlockerOf(base.blockers)),
                        ...bootFailureFor('base', base, booted.base.readyAt),
                    });
                });
                return finish('could_not_boot', { verdictState: 'could_not_boot' }, base.blockers.map((b) => `${b.kind}:${b.signature}`).join(', '));
            }
            if (isBlocked(pr) && infraBootBlocker(pr.blockers)) {
                // The cell, not the PR: out of memory or disk while builds share the cell, or a
                // platform fault. Never a finding against the PR; its paths stay untested, and why.
                const blocker = bootBlockerOf(pr.blockers);
                const ids = await deps.step('uncovered:pr-boot', async () => {
                    const ids = extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) })
                        .filter((e) => e.kind !== 'dependency_surface')
                        .map((e) => e.id);
                    await deps.projection.upsert(req.runId, { uncoveredEntryPoints: ids, uncovered: uncoveredByBoot(ids, blocker), ...bootFailureFor('pr', pr, booted.pr.readyAt) });
                    return ids;
                });
                return finish(
                    'partly_tested',
                    decideRunVerdict({ entryPoints: ids, probes: [] }),
                    `the cell could not start the PR's machine (${pr.blockers.map((b) => `${b.kind}:${b.signature}`).join(', ')}); not attributed to the PR`,
                );
            }
            if (isBlocked(pr)) {
                const boot: ProbeVerdict = {
                    probeId: 'boot',
                    entryPoint: 'boot',
                    verdict: 'finding',
                    findingKind: 'pr_destabilizes_machine',
                    reason: `the PR does not boot while the base does: ${pr.blockers.map((b) => b.signature).join(', ')}`,
                };
                const v = decideRunVerdict({ entryPoints: ['boot'], probes: [boot] });
                await deps.step('verdict:boot', async () =>
                    deps.projection.upsert(req.runId, { probes: [boot], findings: [boot], ...bootFailureFor('pr', pr, booted.pr.readyAt) }),
                );
                return finish('regression', v);
            }
            // Both final acquire outputs are durable: recovery derives the same pin before any LLM or probe.
            const pinnedImageId = acquiredImagePin(req.environment.imageId, base, pr);
            await deps.step('image:pin', async () => deps.projection.upsert(req.runId, { imageId: pinnedImageId }));
            // Both claims are bound and kept leased since each one's boot (bootBoth), never past their hard ceiling.
            await deps.step('cell-owner', async () => deps.projection.upsert(req.runId, { cellOwner: base.cellOwner }));

            // testing
            await transition(deps, req, 'testing');
            const testingAt = await deps.step('testing:at', async () => deps.now().getTime());
            await progress(deps, req, startedAt.at, 'testing', { bootMs: baseMs, applyMs });
            const entryPoints = await deps.step('entry-points', async () =>
                extractEntryPoints(req.diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })), { recipe: recipeChangedInPr(req) }),
            );
            const behavior = entryPoints.filter((e) => e.kind !== 'dependency_surface');
            const diffRefFor = (entryPoint: string, via: string | undefined): Pick<ProbeVerdict, 'diffRef'> => {
                const diffRef = diffRefOf({ entryPoint, via, entryPoints, files: req.diff });
                return diffRef ? { diffRef } : {};
            };
            const dependency = entryPoints.filter((e) => e.kind === 'dependency_surface');

            // A canary crossing a boundary halts the Run (ADR-043): no more probes and no more LLM
            // calls; the gate closes with the Steps already recorded (unverified points stay partly tested).
            let leak: LeakSite | undefined;
            let plan: AgentPlan = { probes: [], tests: [], claims: [], rejected: [], cannotProve: [], explored: 0 };
            let verdictEntryPoints = behavior.map((e) => e.id);
            const verdicts: ProbeVerdict[] = [];
            const allSteps: GateStep[] = [];
            let testRuns: TestRun[] = [];
            let classified: ProbeVerdict[] = verdicts;
            const securityOf = async (claimId: string) => (await deps.claims.securityViolations([claimId]))[0]?.signature;
            try {
                await phase(deps, req, 'agent', { entryPoints: behavior.map((e) => e.id) });
                const planned = await span('runtime.run.agent')(() =>
                    deps.step('agent:plan', async (): Promise<AgentPlan | ClaimLeaseFailed> => {
                        for (const side of ['base', 'pr'] as const) {
                            const claimFailure = await checkClaimLease(deps.env, side === 'base' ? base.claimId : pr.claimId, 'runtime', { side, securityOf });
                            if (claimFailure) return { claimFailure };
                        }
                        if (providedPlan) return providedPlan;
                        return deps.agent.plan({
                            signal: deps.cancellationSignal?.(),
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
                        });
                    }),
                );
                if ('claimFailure' in planned) throwClaimLeaseFailure(planned.claimFailure);
                // The marker survives DBOS JSON checkpoint recovery; throw outside its step.
                if (planned.securityViolation) throw new SecurityViolationError(planned.securityViolation.side, planned.securityViolation.signature);
                plan = planned;
                const exploration = plan.exploration ?? [];
                addTokens(tally, plan.usage);
                tally.probesPlanned = plan.probes.length;
                tally.explored = plan.explored;
                tally.exploreFailed = exploration.filter((c) => c.failed).length;
                if (exploration.length) await deps.step('agent:exploration', async () => deps.projection.upsert(req.runId, { exploration }));

                await phase(deps, req, 'replay', {
                    probes: plan.probes.length,
                    explored: plan.explored,
                    exploreFailed: tally.exploreFailed,
                    viaRoutes: plan.probes.filter((p) => p.via).length,
                    cannotProve: plan.cannotProve.length,
                });
                ctx.steps = allSteps;
                // A changed file with no route of its own is tested through the route the agent says reaches it.
                verdictEntryPoints = entryPointsWithRoutes(behavior.map((e) => e.id), plan.probes);
                for (const [index, planned] of plan.probes.entries()) {
                    const { decision, steps, lanes, responseDiff } = await span('runtime.run.replay')(() =>
                        replayProbe({
                            run: { runId: req.runId, attempt: req.attempt },
                            index,
                            probe: planned.probe,
                            assertions: planned.assertions,
                            securityOf,
                            claims: { base: base.claimId, pr: pr.claimId },
                            pinnedImageId,
                            env: deps.env,
                            step: deps.step,
                            canaries,
                            ...(req.environment.ready ? { ready: req.environment.ready } : {}),
                            ...(deps.evidence ? { evidence: runEvidence(deps, req, 'probe') } : {}),
                        }),
                    );
                    allSteps.push(...steps);
                    // S-32: what the probe covered comes from the observer's request log on both
                    // sides, never from the label the agent wrote.
                    const requestsOf = (side: 'base' | 'pr') => steps.filter((x) => x.side === side).flatMap((x) => x.requests ?? []);
                    const entryPoint = coveredEntryPoint(
                        planned.entryPoint,
                        verdictEntryPoints,
                        { base: requestsOf('base'), pr: requestsOf('pr') },
                    );
                    // What was sent, from the typed spec: shown on the comment and the page, never coverage.
                    const exercised = exercisedOf(planned.probe.spec);
                    verdicts.push({
                        probeId: planned.probe.id,
                        entryPoint,
                        ...(exercised ? { exercised } : {}),
                        ...(planned.via && entryPoint === planned.entryPoint ? { via: planned.via } : {}),
                        verdict: decision.verdict,
                        findingKind: decision.findingKind,
                        // Every finding starts unintended; only the intent classifier below can downgrade it.
                        intent: decision.verdict === 'finding' ? 'unintended' : undefined,
                        reason: decision.reason,
                        differingFields: decision.differingFields,
                        baseStepIds: steps.filter((x) => x.side === 'base').map((x) => x.stepId),
                        prStepIds: steps.filter((x) => x.side === 'pr').map((x) => x.stepId),
                        ...(lanes ? { lanes } : {}),
                        ...(responseDiff ? { responseDiff } : {}),
                        ...diffRefFor(entryPoint, planned.via && entryPoint === planned.entryPoint ? planned.via : undefined),
                    });
                    deps.metrics.recordVerdict(decision.verdict, { orgId: req.organizationId });
                }

                // Intent (§4): the repository tests the agent named run on both sides as internal
                // evidence, then each finding is classified apart from the agent. It only downgrades.
                const tests = plan.tests ?? [];
                if (tests.length) {
                    testRuns = await runPlannedTests({
                        securityOf,
                        run: { runId: req.runId, attempt: req.attempt },
                        tests,
                        pinnedImageId,
                        claims: { base: base.claimId, pr: pr.claimId },
                        env: deps.env,
                        step: deps.step,
                        canaries,
                        ...(deps.evidence ? { evidence: runEvidence(deps, req, 'test') } : {}),
                    });
                }
                if (providedPlan) {
                    classified = verdicts.map((v) => v.verdict === 'finding' ? { ...v, intent: 'uncertain' as const } : v);
                } else if (verdicts.some((v) => v.verdict === 'finding')) {
                    classified = await span('runtime.run.intent')(async () => {
                        await phase(deps, req, 'intent', { findings: verdicts.filter((v) => v.verdict === 'finding').length, tests: testRuns.length });
                        return classifyIntents({
                            verdicts,
                            ctx: {
                                runId: req.runId,
                                organizationId: req.organizationId,
                                runToken: req.runToken,
                                diff: req.diff.map((d) => ({ path: d.path, patch: d.patch })),
                                title: req.pullRequest.title,
                                description: req.pullRequest.description,
                                tests: testRuns,
                            },
                            classifier: deps.intent,
                            step: deps.step,
                            onUsage: (u) => addTokens(tally, u),
                        });
                    });
                }
            } catch (e) {
                if (e instanceof SecurityViolationError) {
                    ctx.securityViolation = { side: e.side, signature: e.signature };
                } else {
                    const site = canaryLeakSite(e);
                    if (!site) throw e;
                    leak = site;
                }
                classified = verdicts;
            }
            const unverifiedClaims = markUnbackedClaims(plan.claims, allSteps).filter((c) => !c.backedByProbe);
            ctx.stoppedEarly = !!leak || !!ctx.securityViolation;
            tally.probesDecided = verdicts.filter((v) => v.verdict !== 'inconclusive').length;
            reportingAt = await deps.step('reporting:at', async () => {
                const at = deps.now().getTime();
                deps.log?.info(phaseLine(req, 'testing', at - testingAt, { probes: plan.probes.length, decided: tally.probesDecided ?? 0 }));
                return at;
            });
            tally.testMs = reportingAt - testingAt;
            await progress(deps, req, startedAt.at, 'reporting', {
                bootMs: baseMs,
                applyMs,
                tested: { done: plan.probes.length, total: plan.probes.length },
                regressions: classified.filter((v) => v.verdict === 'finding' && v.intent !== 'intended').length,
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
            let probes = classified;
            if (containsCanary(JSON.stringify(probes), canaries)) {
                leak ??= 'publish';
                probes = redactDeep(probes, canaries);
            }
            ctx.dependencyChangeUntested = dependency.length > 0 && !verdicts.some((v) => dependency.some((d) => d.id === v.entryPoint));
            const verdict = decideRunVerdict({
                entryPoints: verdictEntryPoints,
                probes,
                blockedOutbound: egress.hosts.filter((e) => e.phase === 'test').length,
                dependencyChangeUntested: ctx.dependencyChangeUntested,
                // A diff the product cut is partly tested at best.
                diffTruncated: req.diffTruncated === true,
            });
            tally.findings = verdict.findings.length;
            if (ctx.securityViolation) await securityViolationEvent(deps, req, ctx.securityViolation);
            else if (leak) await securityEvent(deps, req, leak);
            // What a developer needs to see each finding on their own machine (§5): the observer
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
                await deps.events.append(
                    req.organizationId,
                    req.runId,
                    {
                    type: 'verdict',
                    at: deps.now().toISOString(),
                    data: {
                        verdictState: verdict.verdictState,
                        findings: verdict.findings.length,
                        intended: verdict.intendedFindings.length,
                        tests: testRuns.length,
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
            // halted keeps the computed verdict in verdictState, and the check follows it (§3).
            return finish(leak || ctx.securityViolation ? 'halted' : verdict.verdictState, verdict);
        } catch (e) {
            if (isCancellation(e)) throw e;
            if (e instanceof RunAbort) return finish(e.state, undefined, e.reason);
            if (e instanceof LlmBudgetExceededError || e instanceof LlmUnavailableError) return finish('errored', undefined, `LLM unavailable: ${e.message}`);
            return finish('errored', undefined, (e as Error)?.message ?? 'unknown error');
        } finally {
            // A cancellation (or a throw past finish) ends the renewals too.
            leases.stop();
        }
    });
}

/**
 * The approval gate of a fork PR (ADR-030), run by its own workflow off the
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
        return { approved: { ...rest, repoToken: got.tokens.repoToken, ...(got.tokens.prRepoToken ? { prRepoToken: got.tokens.prRepoToken } : {}), runToken: got.tokens.runToken } };
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
