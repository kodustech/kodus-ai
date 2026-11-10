import { type AcquireRequest, type BakeOutcome, type BakeRequest, type Blocked, type Claim, POOL_SIZE_UNSUPPORTED } from '@libs/runtime/environment';
import type { Envelope, MachineSize, MessageBody, RepoRef } from '@libs/runtime/protocol';
import { redactPatterns } from '@libs/runtime/redaction';
import { bootOutputOf } from '@libs/runtime/run/boot-failure';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import { claimIdFor } from '../../shared/claim-id';
import { inSpan } from '../../shared/observability/tracing';
import { authoredFilesUnsupported, grantsSize, recipeCapabilityBlocker, sizeUnavailable, supports } from '../cell-capabilities';
import type { CellConnection, CellConnectionRegistry } from '../gateway/cell-connections';
import { ClaimCause, ClaimMetering, ClaimRow, ClaimState, HubStore, isFinalClaimState, LIVE_CLAIM_STATES, OPEN_CLAIM_STATES } from '../hub-store';
import { CellUnavailableError, ClaimRef, ClaimScopeError, HubLog, HubLogLine, HubMetrics, ReadyOutcome } from '../hub-types';
import { type ClaimDeadlines, freshDeadlines, readyWaitMs, retryDeadlines } from './claim-deadlines';
import { CellMemoryBook, type MemoryAdmission, siblingKeysOf } from './cell-memory';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { TicketService } from './ticket.service';

// The claim lifecycle on the hub (ADR-051, §1b): acquire (with rebind on a
// retry), the claim.ready / claim.failed outcome, release, and what follows
// a bound claim (egress policy, image bake, pool target). Every state change
// is compare-and-set in the store, so a release racing a boot, or a retried
// acquire racing the first one, can never resurrect or kill the other's claim.

const SETTLED_MAX = 10_000;


/** Claim ids are scoped by org: the same idempotency key in two orgs is two claims. */
export { claimIdFor };

export type AcquireInput = AcquireRequest & { expose: Claim['manifest']['expose']; repo: RepoRef; repoToken: string;
    admission?: PhysicalAdmissionTicket;
};

/** The ids every claim log line carries. */
type ClaimIds = { claimId: string; cellId: string; runId?: string };

/** claim.acquire recipe: the files only when there are any (the cell names authoredFiles, checked before). */
function claimRecipe(r: NonNullable<AcquireInput['recipe']>): MessageBody<'claim.acquire'>['recipe'] {
    return {
        path: r.path,
        content: r.content ?? null,
        ...(r.digest ? { digest: r.digest } : {}),
        ...(r.files?.length ? { files: r.files.map((f) => ({ path: f.path, content: f.content })) } : {}),
    };
}

const released = (): Blocked => ({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'claim_released', message: 'this claim was already released' }] });

/** The cell's nack code for a claim it has no room for (a slot or its memory, ADR-070). */
export const NO_CAPACITY = 'no_capacity';

/**
 * No room for the claim on the cell now (ADR-070): nothing was started, and
 * the worker waits and asks again (isCapacityWait). Never names the cell as
 * the one a boot failed on.
 */
export function noCapacity(cellId: string, message: string, fit?: Extract<MemoryAdmission, { kind: 'wait' }>): Blocked {
    return {
        status: 'blocked',
        blockers: [{ kind: 'resources', signature: NO_CAPACITY, message }],
        capacity: { cellId, ...(fit ? { needMb: fit.needMb, freeMb: fit.freeMb, allocatableMb: fit.allocatableMb, ahead: fit.ahead } : {}) },
    };
}

/** A claim larger than all the memory the cell may commit: waiting would not change it. */
function memoryUnavailable(fit: Extract<MemoryAdmission, { kind: 'too_large' }>): Blocked {
    return {
        status: 'blocked',
        blockers: [
            {
                kind: 'resources',
                signature: 'memory_unavailable',
                message: `the claim needs ${fit.needMb} MB of memory and this cell may commit ${fit.allocatableMb} MB to claims in all; choose a smaller machine size or a larger cell`,
            },
        ],
    };
}

export class ClaimService {
    tickets?: TicketService;
    /** claim.ready / claim.failed already taken, by claimId: a resend (the cell lost the ack) is acked again. Bounded. */
    private readonly settledClaimOutcomes = new Map<string, { type: 'claim.ready' | 'claim.failed'; cellId: string }>();
    /** Acquire rounds in flight on this replica: a duplicate acquire of the same claim joins the first. */
    private readonly inFlight = new Map<string, Promise<Claim | Blocked>>();
    /** What the cells this replica holds may still take, by memory (ADR-070). */
    readonly memory = new CellMemoryBook();

    constructor(
        private readonly store: HubStore,
        private readonly connections: CellConnectionRegistry,
        private readonly metrics: RuntimeMetrics,
        private readonly hubMetrics: HubMetrics,
        private readonly log: HubLog,
        private readonly opts: { readyTimeoutMs?: number; now: () => Date },
    ) {}

    private get now() {
        return this.opts.now;
    }

    /**
     * The one way this service moves a claim: the store's guarded transition,
     * with why. A move that happened is counted by state and reason and
     * logged, so a claim's history is in the logs and its cause in the row.
     */
    private async move(ids: ClaimIds, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause): Promise<boolean> {
        const moved = await this.store.transitionClaim(ids.claimId, from, to, cause);
        if (moved) {
            this.hubMetrics.claimTransition({ to, reason: cause.reason });
            this.log('info', 'claim.transition', { ...ids, to, reason: cause.reason, ...(cause.detail ? { detail: cause.detail } : {}) });
        }
        return moved;
    }

    /**
     * The claim a worker names, checked against the tenant it says it serves:
     * another org, or another Run, is a ClaimScopeError, never acted on.
     */
    async scoped(ref: ClaimRef): Promise<ClaimRow | null> {
        const claim = await this.store.claim(ref.claimId);
        if (!claim) return null;
        if (claim.orgId !== ref.organizationId || (ref.runId !== undefined && (ref.runId ?? null) !== (claim.runId ?? null))) {
            this.metrics.recordProtocolViolation({ cellId: claim.cellId, code: 'claim_scope' });
            this.log('warn', 'claim.scope_refused', { claimId: ref.claimId, cellId: claim.cellId, runId: claim.runId ?? undefined });
            throw new ClaimScopeError('the claim is not this tenant’s');
        }
        return claim;
    }

    /**
     * An unsolicited `blocked` frame (claimId, no re): the cell reports a
     * security violation on one of its live claims. The claim becomes
     * compromised (it takes no step; its machines stay as evidence until the
     * claim is released), the blocker is recorded for the Run, and every wait
     * on the claim on this connection ends with it. Idempotent: a resend is
     * acked again. Returns the claim when this frame compromised it (null when
     * refused, or for a resend).
     */
    async onUnsolicitedBlocked(conn: CellConnection, msg: Envelope<'blocked'>): Promise<ClaimRow | null> {
        const cellId = conn.cred.cellId;
        const body = msg.body as MessageBody<'blocked'>;
        if (body.kind !== 'security_violation') {
            this.connections.nack(conn, msg.id, 'unsolicited_blocked', 'only a security_violation is reported without a request');
            return null;
        }
        const claim = msg.claimId ? await this.store.claim(msg.claimId) : null;
        if (!claim || claim.cellId !== cellId || !(claim.state === 'compromised' || (LIVE_CLAIM_STATES as readonly ClaimState[]).includes(claim.state))) {
            this.log('warn', 'claim.violation_refused', { cellId, claimId: msg.claimId, state: claim?.state });
            this.connections.nack(conn, msg.id, 'unknown_claim', 'claim is not live on this cell');
            return null;
        }
        const first = await this.move({ claimId: claim.claimId, cellId, runId: claim.runId ?? undefined }, LIVE_CLAIM_STATES, 'compromised', { reason: 'security_violation', detail: body.signature });
        if (!first && (await this.store.claim(claim.claimId))?.state !== 'compromised') {
            this.connections.nack(conn, msg.id, 'unknown_claim', 'claim is not live on this cell');
            return null;
        }
        // Recorded on every delivery (idempotent), so a crash between the transition and this write is healed by the resend.
        await this.store.recordClaimBlocker({
            claimId: claim.claimId,
            orgId: claim.orgId,
            runId: claim.runId,
            cellId,
            side: claim.side,
            kind: body.kind,
            signature: body.signature,
            message: body.message,
            at: this.now().toISOString(),
        });
        this.connections.ack(conn, msg.id);
        if (!first) return null;
        this.metrics.recordSecurityEvent({ orgId: claim.orgId, kind: 'exfiltration', where: claim.side });
        this.log('error', 'claim.compromised', { cellId, claimId: claim.claimId, runId: claim.runId ?? undefined, side: claim.side, signature: body.signature });
        const waiting = conn.readies.get(claim.claimId);
        if (waiting) {
            conn.readies.delete(claim.claimId);
            clearTimeout(waiting.timer);
            waiting.resolve({ type: 'failed', body: { kind: 'security_violation', signature: body.signature, reason: body.message } });
        }
        for (const [stepId, s] of conn.steps) {
            if (s.claimId !== claim.claimId) continue;
            conn.steps.delete(stepId);
            clearTimeout(s.timer);
            s.resolve({ type: 'compromised', signature: body.signature });
        }
        return claim;
    }

    /**
     * Why a claim did not boot, kept with the claim (runtime_claim_blockers):
     * the kind and signature the cell sent, the error line and the last 40
     * lines of the build or compose output, redacted again with the token
     * patterns (the cell's claim redactor ran first, S-51). Never fails the
     * acquire: an unwritten row is logged and the blocker still goes back.
     */
    private async recordBootBlocker(
        ids: ClaimIds & { orgId: string },
        side: string,
        b: { kind: string; signature: string; message: string; bundle?: MessageBody<'claim.failed'>['bundle'] },
    ): Promise<void> {
        try {
            const clean = (text: string) => redactPatterns(text).text;
            const out = bootOutputOf(b, clean);
            const message = out.errorLine ?? clean(b.message ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
            await this.store.recordClaimBlocker({
                claimId: ids.claimId,
                orgId: ids.orgId,
                runId: ids.runId ?? null,
                cellId: ids.cellId,
                side,
                kind: b.kind,
                signature: b.signature,
                message: message.slice(0, 1_024),
                ...(out.logTail.length ? { logTail: out.logTail } : {}),
                at: this.now().toISOString(),
            });
        } catch (e) {
            this.log('warn', 'claim.blocker_unrecorded', { ...ids, kind: b.kind, signature: b.signature, error: (e as Error).message });
        }
    }

    /** The violation recorded on a compromised claim (its signature), for a step that asks for it later. */
    async violationOf(claimId: string): Promise<string | undefined> {
        return (await this.store.claimBlockers([claimId])).find((b) => b.kind === 'security_violation')?.signature;
    }

    /** A bound claim (or held, for exec), live before its hard expiry; null otherwise. */
    async findActiveClaim(ref: ClaimRef, opts: { allowHeld?: boolean } = {}): Promise<ClaimRow | null> {
        const claim = await this.scoped(ref);
        if (!claim) return null;
        if (!(claim.state === 'bound' || (opts.allowHeld && claim.state === 'held'))) return null;
        if (Date.parse(claim.hardExpiresAt) <= this.now().getTime()) return null;
        return claim;
    }

    /**
     * claim.acquire on a cell held by this replica. The ack only means
     * "accepted"; the claim is bound on claim.ready and fails on claim.failed.
     */
    acquire(cellId: string, req: AcquireInput): Promise<Claim | Blocked> {
        const claimId = claimIdFor(req.organizationId, req.idempotencyKey);
        const joined = this.inFlight.get(claimId);
        if (joined) {
            this.log('info', 'claim.acquire.joined', { cellId, claimId, runId: req.runId });
            return joined;
        }
        const round = inSpan('runtime.hub.claim.acquire', { 'runtime.cell.id': cellId, 'runtime.claim.id': claimId, 'runtime.claim.side': req.ref.side }, () =>
            this.acquireRound(cellId, claimId, req),
        ).finally(() => this.inFlight.delete(claimId));
        this.inFlight.set(claimId, round);
        return round;
    }

    private async acquireRound(cellId: string, claimId: string, req: AcquireInput): Promise<Claim | Blocked> {
        const session = await this.store.session(cellId);
        if (!session) throw new CellUnavailableError(cellId);
        if (session.owner === 'customer' && session.orgId !== req.organizationId) {
            // Claims of an org only go to that org's cells or to managed cells (ADR-054).
            this.metrics.recordProtocolViolation({ cellId, code: 'cross_org_claim' });
            throw new ClaimScopeError('cell does not serve this organization');
        }
        const conn = this.connections.require(cellId);
        // Validate before ticket mutation, memory admission, claim records or
        // frames: older cells must not silently ignore executable recipe fields.
        const recipeBlocker = recipeCapabilityBlocker(session, req.recipe);
        if (recipeBlocker) {
            this.log('warn', 'claim.recipe_capability_refused', { cellId, claimId, runId: req.runId, signature: recipeBlocker.blockers[0].signature });
            return recipeBlocker;
        }
        if (
            !req.admission &&
            this.memory.ticketMemberReserved(cellId, claimId)
        ) {
            return {
                status: 'blocked',
                blockers: [
                    {
                        kind: 'platform',
                        signature: 'admission_ticket_required',
                        message:
                            'this claim belongs to a physical admission ticket',
                    },
                ],
            };
        }
        if (
            req.admission &&
            (!this.tickets ||
                req.admission.cellId !== cellId ||
                !(await this.tickets.authorizeAcquire(req.admission, req)) ||
                !this.tickets.prepare(req.admission, claimId))
        ) {
            return {
                status: 'blocked',
                blockers: [
                    {
                        kind: 'platform',
                        signature: 'admission_ticket_invalid',
                        message:
                            'the physical admission ticket is no longer valid; Run again',
                    },
                ],
            };
        }
        const at = this.now().getTime();
        const ids = { cellId, claimId, runId: req.runId, orgId: req.organizationId, environmentId: req.environmentId };
        if (req.size && !grantsSize(session, req.size)) {
            // Never sent without the size (the workload would boot at the cell's default and
            // die of memory), nor to a cell that cannot read it: the worker routes a sized
            // claim to a cell that grants it, so this is a cell that changed since.
            this.log('warn', 'claim.size_unavailable', { ...ids, memoryMb: req.size.memoryMb, cpus: req.size.cpus });
            return sizeUnavailable(session, req.size);
        }
        if (req.recipe?.files?.length && !supports(session, 'authoredFiles')) {
            // Never booted without them: the recipe names files only they provide. Nothing was sent or recorded.
            this.log('warn', 'claim.authored_files_unsupported', { ...ids, files: req.recipe.files.length });
            return authoredFilesUnsupported();
        }
        // Memory (ADR-070), checked and taken with no await in between, before anything is recorded or sent.
        const siblingKeys = siblingKeysOf(req.runId, req.idempotencyKey);
        const fit = this.memory.admit(
            cellId,
            { claimId, runId: req.runId, side: req.ref.side, consumer: req.consumer, sizeMb: req.size?.memoryMb, ...(siblingKeys.length ? { siblingClaimIds: siblingKeys.map((k) => claimIdFor(req.organizationId, k)) } : {}) },
            at,
        );
        if (fit.kind === 'too_large') {
            this.log('warn', 'claim.memory_unavailable', { ...ids, needMb: fit.needMb, allocatableMb: fit.allocatableMb });
            return memoryUnavailable(fit);
        }
        if (fit.kind === 'wait') {
            this.hubMetrics.claimCapacityWait({ consumer: req.consumer });
            this.log('info', 'claim.no_capacity', { ...ids, side: req.ref.side, needMb: fit.needMb, freeMb: fit.freeMb, allocatableMb: fit.allocatableMb, ahead: fit.ahead });
            const why = fit.ahead ? `${fit.ahead} claim(s) asked this cell first and still wait` : `the claim needs ${fit.needMb} MB of memory and ${fit.freeMb} of the cell's ${fit.allocatableMb} MB are free`;
            return noCapacity(cellId, `${why}; nothing was started, the claim waits for room`, fit);
        }
        if (fit.kind === 'admitted') this.log('info', 'claim.memory_admitted', { ...ids, side: req.ref.side, needMb: fit.needMb, siblingMb: fit.siblingMb });
        // What this round holds, recorded with it once: the Run's cost is priced from it (ClaimMetering).
        const sizes = fit.kind === 'admitted' ? this.memory.sizesOf(cellId, { side: req.ref.side, consumer: req.consumer, sizeMb: req.size?.memoryMb }) : null;
        if (sizes && req.admission)
            sizes.bootMb =
                this.memory.ticketOf(req.admission)?.bootMb ?? sizes.bootMb;
        const metering: ClaimMetering = { driver: session.driver, bootMb: sizes?.bootMb ?? null, readyMb: sizes?.readyMb ?? null, allocatableMb: sizes?.allocatableMb ?? null };
        let deadlines: ClaimDeadlines | null;
        try {
            deadlines = await this.recordRound(cellId, claimId, req, at, ids, metering);
        } catch (e) {
            this.memory.forget(cellId, claimId);
            throw e;
        }
        if (!deadlines) {
            this.memory.forget(cellId, claimId);
            return released();
        }
        const { leaseExpiresAt, hardExpiresAt } = deadlines;

        // A new round: what the cell settled for this claimId before no longer answers it.
        this.settledClaimOutcomes.delete(claimId);
        // From claim.acquire to claim.ready (machines, code, observer), never past the claim's ceiling.
        const ready = this.awaitReady(conn, claimId, readyWaitMs(req.consumer, deadlines, at));
        // A diagnostic hold is only ever asked for a setup claim that is not a PR (§11 runbook).
        const hold = req.diagnosticHold === true && req.consumer === 'setup' && req.ref.side !== 'pr';
        // Optional work a cell that cannot read the field simply goes without (the cache is seeded at the bake).
        const seedsCache = req.seedsCache === true && req.consumer === 'setup' && req.ref.side !== 'pr' && supports(session, 'seedsCache');
        this.log('info', 'claim.acquire', {
            ...ids,
            side: req.ref.side,
            consumer: req.consumer,
            sha: req.ref.sha,
            expose: req.expose.length,
            ...(req.size ? { memoryMb: req.size.memoryMb, cpus: req.size.cpus } : {}),
        });
        // The approved hosts travel with the acquire: a build that starts at once (a Dockerfile's
        // apk add) already has them. Unreadable, or a cell that cannot decode the field: the claim
        // starts on the base list, and the push after ready (or a later approval) still reaches it.
        const egressAllow = supports(session, 'egressAllow') ? await this.approvedHostsOf(req.organizationId, req.environmentId, ids) : [];
        // The Run's decoys (ADR-043), to a cell that plants them; never logged here. A cell that
        // cannot read the field plants none, and the worker still checks every boundary for them.
        const canaries = req.consumer !== 'setup' && req.canaries?.length && supports(session, 'canaries') ? req.canaries.map((c) => ({ slot: c.slot, value: c.value })) : [];
        let reply: Envelope;
        try {
            if (
                req.admission &&
                (!(await this.tickets!.authorizeAcquire(req.admission, req)) ||
                    !this.tickets!.consume(req.admission, claimId))
            )
                throw new CellUnavailableError(
                    'the physical admission ticket is no longer valid',
                );
            reply = await this.connections.request(
                cellId,
                'claim.acquire',
                {
                    orgId: req.organizationId,
                    environmentId: req.environmentId,
                    ...(req.runId ? { runId: req.runId } : {}),
                    imageId: req.imageId ?? 'latest',
                    side: req.ref.side,
                    sha: req.ref.sha,
                    consumer: req.consumer,
                    repo: req.repo,
                    repoToken: req.repoToken,
                    expose: req.expose,
                    hardExpiresAt,
                    leaseExpiresAt,
                    ...(hold ? { diagnosticHold: true } : {}),
                    ...(seedsCache ? { seedsCache: true } : {}),
                    ...(req.recipe ? { recipe: claimRecipe(req.recipe) } : {}),
                    ...(egressAllow.length ? { egressAllow } : {}),
                    // The environment's machine size, which the cell grants (checked above).
                    ...(req.size ? { size: { memoryMb: req.size.memoryMb, cpus: req.size.cpus } } : {}),
                    ...(canaries.length ? { canaries } : {}),
                },
                claimId,
            );
        } catch (e) {
            this.forgetReady(conn, claimId);
            this.memory.forget(cellId, claimId);
            await this.move(ids, ['pending'], 'failed', { reason: 'acquire_unanswered' });
            this.log('warn', 'claim.acquire.unanswered', { ...ids, error: (e as Error).message });
            throw e;
        }
        if (reply.type !== 'ack') {
            this.forgetReady(conn, claimId);
            this.memory.forget(cellId, claimId);
        }
        if (reply.type === 'blocked' || reply.type === 'nack') {
            if (reply.type === 'blocked') {
                const b = reply.body as MessageBody<'blocked'>;
                await this.move(ids, ['pending'], 'blocked', { reason: 'cell_blocked', detail: b.signature });
                await this.recordBootBlocker(ids, req.ref.side, { kind: b.kind, signature: b.signature, message: b.message });
                this.log('warn', 'claim.blocked', { ...ids, kind: b.kind, signature: b.signature });
                return { status: 'blocked', blockers: [{ kind: b.kind, signature: b.signature, message: b.message }] };
            }
            const b = reply.body as MessageBody<'nack'>;
            await this.move(ids, ['pending'], 'blocked', { reason: 'cell_refused', detail: b.code });
            this.log('warn', 'claim.acquire.nacked', { ...ids, code: b.code });
            // The cell's own ledger had no room (a slot, or memory the hub did not see yet): wait, never a failure.
            if (b.code === NO_CAPACITY) return noCapacity(cellId, `the cell has no room for the claim now (${b.message}); nothing was started, the claim waits for room`);
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: b.code, message: b.message }] };
        }

        const outcome = await ready;
        const waitedMs = this.now().getTime() - at;
        // Not ready: the cell no longer counts it (or never did); ready: the cell's report counts it.
        if (outcome.type !== 'ready') this.memory.forget(cellId, claimId);
        this.hubMetrics.claimReadyWait(waitedMs, { outcome: outcome.type, consumer: req.consumer, driver: session.driver });
        if (outcome.type === 'released') {
            this.log('info', 'claim.released_while_booting', { ...ids, waitedMs });
            return released();
        }
        if (outcome.type === 'lost') {
            await this.move(ids, ['pending'], 'failed', { reason: 'not_ready', detail: outcome.why });
            this.log('error', 'claim.not_ready', { ...ids, waitedMs, why: outcome.why });
            if (outcome.why === 'timeout') {
                // The boot outlived the ceiling: stop it now instead of at the next heartbeat's reconcile.
                void this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
                const minutes = Math.round(waitedMs / 60_000);
                return {
                    status: 'blocked',
                    blockers: [{ kind: 'resources', signature: 'boot_timeout', message: `the boot did not finish in ${minutes} min, the most a setup waits` }],
                    cellId,
                };
            }
            if (outcome.why === 'disconnected') {
                return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'cell_lost', message: 'the cell disconnected while the claim was booting' }] };
            }
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'claim_not_ready', message: 'the cell did not report the claim ready' }] };
        }
        if (outcome.type === 'failed') {
            const { kind, signature, reason, bundle, held } = outcome.body;
            const blocker = { kind, signature, message: reason, ...(bundle ? { bundle } : {}) };
            const detail = `${kind}/${signature}`;
            // Recorded before the claim moves on, held or failed: the proof outlives the cell's cleanup.
            await this.recordBootBlocker(ids, req.ref.side, blocker);
            if (held && hold && (await this.move(ids, ['pending'], 'held', { reason: 'held_for_diagnosis', detail }))) {
                // The cell kept the machines: exec and release only, until hardExpiresAt.
                this.log('warn', 'claim.held', { ...ids, kind, signature, waitedMs, hardExpiresAt });
                return { status: 'blocked', blockers: [blocker], held: { claimId, cellId, hardExpiresAt }, cellId };
            }
            await this.move(ids, ['pending'], 'failed', { reason: 'boot_failed', detail });
            this.log('warn', 'claim.failed', { ...ids, kind, signature, waitedMs });
            return { status: 'blocked', blockers: [blocker], cellId };
        }
        if (!(await this.move(ids, ['pending'], 'bound', { reason: 'ready' }))) {
            // Released (or rebound elsewhere) while the cell was booting: the machines go back.
            this.log('warn', 'claim.ready_after_release', { ...ids, waitedMs });
            await this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
            return released();
        }
        const { manifest, observer, timing } = outcome.body;
        // The phases as numbers; the build steps (names) go with the claim to the Run, not into this line.
        const { buildSteps, ...phases } = timing ?? { prepareMs: 0 };
        this.log('info', 'claim.ready', {
            ...ids,
            waitedMs,
            ...(timing ? phases : {}),
            ...(buildSteps ? { buildSteps: buildSteps.steps, buildStepsCached: buildSteps.cached, slowestBuildStepMs: buildSteps.slowest[0]?.ms ?? 0 } : {}),
            services: manifest.services.length,
            seedSha: manifest.seedSha,
        });
        this.hubMetrics.claimBootPhases(timing, { consumer: req.consumer, driver: session.driver });
        // A claim created after an approval gets the environment's approved hosts now, not only the base list.
        await this.pushApprovedHosts(cellId, claimId, req.organizationId, req.environmentId, ids);
        return {
            claimId,
            cellId,
            cellOwner: session.owner,
            ...(session.features?.includes('browserExplore') ? { capabilities: { browserExplore: 'v1' as const } } : {}),
            leaseExpiresAt,
            hardExpiresAt,
            observer: { id: observer.id, state: observer.state },
            manifest: { services: manifest.services, expose: manifest.expose, imageId: manifest.imageId, seedSha: manifest.seedSha },
            ...(timing ? { timing } : {}),
        };
    }

    /**
     * Records this round of the claim, pending on `cellId`, and returns the
     * deadlines its claim.acquire carries; null when the claim is already
     * released.
     *
     * A retry (the claim exists: the earlier round was lost, failed, or went
     * to another cell) is rebound here, and its claim.ready must come from
     * this cell now. Only the deadlines of a retry are made to match what a
     * cell that rejoins the claim enforces (retryDeadlines): the rest of the
     * first round's body, which such a cell also keeps, may differ from this
     * one without harm. Its egressAllow is replaced by the push after ready;
     * seedsCache only saves a later build its layers (the bake seeds the
     * cache anyway); size and recipe were the environment's a moment
     * earlier and the hub reports neither; and a diagnostic hold is honoured
     * only when this round asked for it, otherwise the claim fails and the
     * heartbeat reconcile releases the machines the cell kept.
     */
    private async recordRound(cellId: string, claimId: string, req: AcquireInput, at: number, ids: ClaimIds, metering: ClaimMetering): Promise<ClaimDeadlines | null> {
        const fresh = freshDeadlines(req.consumer, at);
        const inserted = await this.store.insertClaim({
            claimId,
            cellId,
            orgId: req.organizationId,
            environmentId: req.environmentId,
            runId: req.runId,
            side: req.ref.side,
            state: 'pending',
            consumer: req.consumer,
            metering,
            ...fresh,
        });
        if (inserted) return fresh;
        const existing = await this.store.claim(claimId);
        if (!existing || isFinalClaimState(existing.state)) return null;
        if (existing.environmentId && existing.environmentId !== req.environmentId) throw new ClaimScopeError('the claim belongs to another environment');
        // A round the cell refused for room never ran there: the claim starts its lifetime now.
        const neverRan = existing.state === 'blocked' && existing.reasonDetail === NO_CAPACITY;
        const deadlines = retryDeadlines(neverRan ? { ...existing, cellId: '' } : existing, cellId, fresh, at);
        if (!(await this.store.rebindClaim(claimId, { cellId, ...deadlines, metering }))) return null;
        this.log('info', 'claim.rebound', {
            ...ids,
            previousCellId: existing.cellId,
            previousState: existing.state,
            keptDeadlines: deadlines.hardExpiresAt === existing.hardExpiresAt,
        });
        return deadlines;
    }

    private awaitReady(conn: CellConnection, claimId: string, timeoutMs: number): Promise<ReadyOutcome> {
        // Registered before the request goes out: claim.ready may arrive right after the ack.
        const previous = conn.readies.get(claimId);
        if (previous) {
            clearTimeout(previous.timer);
            previous.resolve({ type: 'lost', why: 'superseded' });
        }
        return new Promise<ReadyOutcome>((resolve) => {
            const timer = setTimeout(() => {
                if (conn.readies.get(claimId)?.timer === timer) conn.readies.delete(claimId);
                resolve({ type: 'lost', why: 'timeout' });
            }, this.opts.readyTimeoutMs ?? timeoutMs);
            conn.readies.set(claimId, { resolve, timer });
        });
    }

    private forgetReady(conn: CellConnection, claimId: string) {
        const r = conn.readies.get(claimId);
        if (r) clearTimeout(r.timer);
        conn.readies.delete(claimId);
    }

    /** A claim.ready or claim.failed frame from a cell. */
    async onOutcome(conn: CellConnection, msg: Envelope<'claim.ready'> | Envelope<'claim.failed'>): Promise<void> {
        const cellId = conn.cred.cellId;
        const prior = msg.claimId ? this.settledClaimOutcomes.get(msg.claimId) : undefined;
        if (prior && prior.cellId === cellId) {
            // A resend: the cell did not get our ack. Idempotent by claimId.
            if (prior.type !== msg.type) return this.connections.nack(conn, msg.id, 'claim_settled', `claim already settled by ${prior.type}`);
            this.log('info', `${msg.type}.duplicate`, { cellId, claimId: msg.claimId });
            return this.connections.ack(conn, msg.id);
        }
        const claim = msg.claimId ? await this.store.claim(msg.claimId) : null;
        const waiting = msg.claimId ? conn.readies.get(msg.claimId) : undefined;
        // Only the cell that holds the claim, on the connection the claim.acquire went out on.
        if (!claim || claim.cellId !== cellId || claim.state !== 'pending' || !waiting) {
            this.log('warn', `${msg.type}.refused`, { cellId, claimId: msg.claimId, runId: claim?.runId ?? undefined, state: claim?.state });
            return this.connections.nack(conn, msg.id, 'unknown_claim', 'claim is not pending on this connection');
        }
        conn.readies.delete(claim.claimId);
        clearTimeout(waiting.timer);
        this.settledClaimOutcomes.set(claim.claimId, { type: msg.type, cellId });
        if (this.settledClaimOutcomes.size > SETTLED_MAX) this.settledClaimOutcomes.delete(this.settledClaimOutcomes.keys().next().value!);
        this.connections.ack(conn, msg.id);
        waiting.resolve(
            msg.type === 'claim.ready'
                ? { type: 'ready', body: msg.body as MessageBody<'claim.ready'> }
                : { type: 'failed', body: msg.body as MessageBody<'claim.failed'> },
        );
    }

    /**
     * Ends a claim. The state moves first (any open state → released), so a
     * claim.ready arriving after this is refused and the cell gets the
     * machines back; a boot waiting on this replica returns at once.
     */
    async release(ref: ClaimRef): Promise<void> {
        const claim = await this.scoped(ref);
        if (!claim || isFinalClaimState(claim.state)) return;
        const ids = { cellId: claim.cellId, claimId: claim.claimId, runId: claim.runId ?? undefined };
        const moved = await this.move(ids, OPEN_CLAIM_STATES, 'released', { reason: 'released' });
        this.memory.forget(claim.cellId, claim.claimId);
        const conn = this.connections.get(claim.cellId);
        const waiting = conn?.readies.get(claim.claimId);
        if (conn && waiting) {
            conn.readies.delete(claim.claimId);
            clearTimeout(waiting.timer);
            waiting.resolve({ type: 'released' });
        }
        this.settledClaimOutcomes.delete(claim.claimId);
        try {
            const reply = await this.connections.request(claim.cellId, 'claim.release', {}, claim.claimId);
            if (reply.type === 'ack')
                this.tickets?.noteReleased(claim.cellId, claim.claimId);
            this.log('info', 'claim.release', { ...ids, moved, reply: reply.type });
        } catch (e) {
            // The cell's lease, dead-man and the reaper clean it up (§1b).
            this.log('warn', 'claim.release', { ...ids, moved, error: (e as Error).message });
        }
    }

    /**
     * Heartbeat reconciliation: a claim the cell still holds that the hub has
     * finished (or never knew) gets claim.release. A claim the hub thinks bound
     * that the cell no longer reports is only logged (it may be booting).
     */
    async reconcile(conn: CellConnection, reported: Array<{ claimId: string }>): Promise<void> {
        const cellId = conn.cred.cellId;
        const live = new Map((await this.store.liveClaimsOfCell(cellId)).map((c) => [c.claimId, c] as const));
        for (const { claimId } of reported) {
            if (live.has(claimId)) continue;
            const row = await this.store.claim(claimId);
            // A compromised claim's machines are evidence: only the Run's end (or the reaper) releases them.
            if (row && row.cellId === cellId && (row.state === 'compromised' || (LIVE_CLAIM_STATES as readonly ClaimState[]).includes(row.state))) continue;
            this.hubMetrics.claimReconciled();
            this.log('warn', 'claim.reconciled_release', { cellId, claimId, state: row?.state ?? 'unknown' });
            // Not awaited: the heartbeat's frame chain never waits on a cell's ack.
            void this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
        }
        const reportedIds = new Set(reported.map((r) => r.claimId));
        for (const c of live.values()) {
            if (c.state === 'bound' && !reportedIds.has(c.claimId)) this.log('warn', 'claim.missing_on_cell', { cellId, claimId: c.claimId, runId: c.runId ?? undefined });
        }
    }

    /** egress.policy with the environment's approved hosts, to one claim right after claim.ready. */
    /** The environment's approved hosts, lowercased and sorted; empty when they cannot be read (logged). */
    private async approvedHostsOf(orgId: string, environmentId: string, ids: Omit<HubLogLine, 'level' | 'msg' | 'replicaId'>): Promise<string[]> {
        try {
            return [...new Set((await this.store.approvedHosts(orgId, environmentId)).map((h) => h.toLowerCase()))].sort().slice(0, 256);
        } catch (e) {
            this.log('error', 'claim.egress_policy.unread', { ...ids, error: (e as Error).message });
            return [];
        }
    }

    private async pushApprovedHosts(cellId: string, claimId: string, orgId: string, environmentId: string, ids: Omit<HubLogLine, 'level' | 'msg' | 'replicaId'>) {
        const hosts = await this.approvedHostsOf(orgId, environmentId, ids);
        if (!hosts.length) return;
        try {
            const reply = await this.connections.request(cellId, 'egress.policy', { allow: hosts, issuedAt: this.now().toISOString() }, claimId);
            this.log(reply.type === 'ack' ? 'info' : 'warn', 'claim.egress_policy', { ...ids, hosts: hosts.length, reply: reply.type });
        } catch (e) {
            // The claim keeps the base list; an approval after this still reaches it (pushEgressPolicy).
            this.log('warn', 'claim.egress_policy', { ...ids, hosts: hosts.length, error: (e as Error).message });
        }
    }

    /**
     * An approved egress host reaches the environment's live claims (ADR-034):
     * the claim's full allowlist goes to the cell that holds it, replacing the
     * previous one. Only the cells this replica holds are reached; returns the claims sent to.
     */
    async pushEgressPolicy(orgId: string, environmentId: string, allow: string[]): Promise<string[]> {
        const sent: string[] = [];
        const hosts = [...new Set(allow.map((h) => h.toLowerCase()))].sort();
        for (const claim of await this.store.liveClaimsOfEnvironment(orgId, environmentId)) {
            if (!this.connections.get(claim.cellId)) continue;
            try {
                const reply = await this.connections.request(claim.cellId, 'egress.policy', { allow: hosts, issuedAt: this.now().toISOString() }, claim.claimId);
                if (reply.type === 'ack') sent.push(claim.claimId);
                this.log('info', 'claim.egress_policy', { cellId: claim.cellId, claimId: claim.claimId, runId: claim.runId ?? undefined, hosts: hosts.length, reply: reply.type });
            } catch (e) {
                // The cell's next claim gets the list in its acquire path; a dead cell has no live claim.
                this.log('warn', 'claim.egress_policy', { cellId: claim.cellId, claimId: claim.claimId, error: (e as Error).message });
            }
        }
        return sent;
    }

    /**
     * image.bake (S-52): only for the default-branch commit the setup claim
     * booted. A bake tied to a PR claim or to a Run's claim is refused here,
     * before it reaches the cell (which refuses it again).
     */
    async bake(req: BakeRequest & { claimId: string }): Promise<BakeOutcome> {
        const claim = await this.store.claim(req.claimId);
        if (!claim || claim.orgId !== req.organizationId || (claim.environmentId && claim.environmentId !== req.environmentId)) {
            return { status: 'refused', code: 'unknown_claim', message: 'the claim is not this environment' };
        }
        if (claim.side === 'pr') {
            this.metrics.recordProtocolViolation({ cellId: claim.cellId, code: 'bake_from_pr' });
            return { status: 'refused', code: 'pr_claim', message: 'a claim that ran PR code never becomes an image (S-52)' };
        }
        if (claim.runId || claim.side !== 'setup') return { status: 'refused', code: 'not_setup_claim', message: 'only a setup claim can ask for a bake' };
        if (claim.state !== 'bound') return { status: 'refused', code: 'claim_not_bound', message: `the claim is ${claim.state}` };
        let reply: Envelope;
        try {
            reply = await this.connections.request(claim.cellId, 'image.bake', { orgId: req.organizationId, environmentId: req.environmentId, recipeSha: req.recipeSha, sha: req.sha }, claim.claimId);
        } catch (e) {
            if (e instanceof CellUnavailableError) return { status: 'refused', code: 'cell_unavailable', message: e.message };
            throw e;
        }
        if (reply.type === 'nack') {
            const b = reply.body as MessageBody<'nack'>;
            return { status: 'refused', code: b.code, message: b.message };
        }
        return { status: 'accepted' };
    }

    /** pool.target (S-52): pool machines come from a baked image, never from a claim. */
    async poolTarget(cellId: string, req: { organizationId: string; environmentId: string; imageId: string; size: number; machineSize?: MachineSize; claimId?: string }): Promise<BakeOutcome> {
        if (req.claimId) {
            const claim = await this.store.claim(req.claimId);
            if (claim?.side === 'pr') return { status: 'refused', code: 'pr_claim', message: 'a claim that ran PR code never becomes a pool machine (S-52)' };
            return { status: 'refused', code: 'pool_from_claim', message: 'pool machines come from a baked image, never from a claim' };
        }
        const session = await this.store.session(cellId);
        if (session?.owner === 'customer' && session.orgId !== req.organizationId) throw new ClaimScopeError('cell does not serve this organization');
        // A cell that does not decode machineSize would make the pool at its default size, which a
        // sized Run's claim never adopts: it is asked for no machines instead (draining any it kept).
        const sizedOnOldCell = !!req.machineSize && !supports(session ?? {}, 'poolMachineSize');
        const body = { orgId: req.organizationId, environmentId: req.environmentId, imageId: req.imageId, size: sizedOnOldCell ? 0 : req.size };
        const reply = await this.connections.request(cellId, 'pool.target', req.machineSize && !sizedOnOldCell ? { ...body, machineSize: req.machineSize } : body);
        if (reply.type === 'nack') {
            const b = reply.body as MessageBody<'nack'>;
            return { status: 'refused', code: b.code, message: b.message };
        }
        if (sizedOnOldCell) return { status: 'refused', code: POOL_SIZE_UNSUPPORTED, message: 'this cell makes pool machines only at its default size; update it to keep a pool for this machine size' };
        return { status: 'accepted' };
    }
}
