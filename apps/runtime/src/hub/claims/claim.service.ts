import { type ClaimState, isClaimStateIn, isFinalClaimState, LIVE_CLAIM_STATES, MACHINE_HOLDING_CLAIM_STATES, OPEN_CLAIM_STATES } from '@libs/runtime/contracts/enums';
import { type AcquireRequest, type Blocked, type Claim, claimCeilingSeconds, isolationUnavailable, machineMinutesExhausted, readyTimeoutMinutes } from '@libs/runtime/environment';
import { isolationSatisfies } from '@libs/runtime/contracts/isolation';
import { type ClaimRepo, type ClaimRunIdentity, type ClaimSecret, type Envelope, MAX_SHARED_IMAGES, type MessageBody, type RepoRef, type SharedImage } from '@libs/runtime/protocol';
import { redactPatterns } from '@libs/runtime/redaction';
import { bootOutputOf } from '@libs/runtime/run/boot-failure';
import { memberAliasOfReason } from '@libs/runtime/run/run-workspace';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';
import { blockerSignatureClass, telemetryDetail, telemetryPhaseName } from '@libs/runtime/telemetry';
import { claimHeldMinutes, claimMbMinutes } from '@libs/runtime/api/domain/run-cost';

import { claimIdFor } from '../../shared/claim-id';
import { DEFAULT_SANDBOX_MEMORY_MB } from '../../shared/config';
import { inSpan } from '../../shared/observability/tracing';
import { authoredFilesUnsupported, grantsSize, recipeCapabilityBlocker, sizeUnavailable, supports, workspaceUnsupported } from '../cell-capabilities';
import type { CellConnection, CellConnectionRegistry } from '../gateway/cell-connections';
import type { CellSession, ClaimCause, ClaimMetering, ClaimRow, EvictedBuildStateRow, HubStore } from '../hub-store';
import { CellUnavailableError, ClaimRef, ClaimScopeError, HubLog, HubMetrics, ReadyOutcome } from '../hub-types';
import { ClaimEgressService, receivesApprovedHosts } from './claim-egress.service';
import { type ClaimDeadlines, freshDeadlines, readyWaitMs, retryDeadlines } from './claim-deadlines';
import { CellMemoryBook, type MemoryAdmission, siblingKeysOf } from './cell-memory';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { TicketService } from './ticket.service';
import type { MachineMinuteBudget } from './machine-minutes';
import type { OrgSecretRefs } from './org-secret-refs';

// The claim lifecycle on the hub: acquire (with rebind on a retry), the
// claim.ready / claim.failed outcome and release. The egress policy of a
// claim is ClaimEgressService's, bakes and pool targets ClaimImageService's.
// Every state change
// is compare-and-set in the store, so a release racing a boot, or a retried
// acquire racing the first one, can never resurrect or kill the other's claim.

const SETTLED_MAX = 10_000;


/** Claim ids are scoped by org: the same idempotency key in two orgs is two claims. */
export { claimIdFor };

/**
 * repo and repoToken: what the cell downloads; a sandbox claim (consumer
 * sandbox) has neither, its caller fetches its code itself. sandboxEgress:
 * the hosts a sandbox claim may reach (sandbox.acquire egressAllow), on top
 * of the hosts approved for sandboxes (never an environment's, G5).
 */
export type AcquireInput = AcquireRequest & { expose: Claim['manifest']['expose']; repo?: RepoRef; repoToken?: string; sandboxEgress?: string[];
    /** A sandbox claim that asked for the org's secrets (SandboxOpen.secrets). */
    sandboxSecrets?: boolean;
    /**
     * A sandbox claim's memory snapshots (feature snapshots): it prepares
     * its org's template under templateKey, starts from the newest template
     * of templateKey, or resumes the session resumeFrom.
     */
    sandboxSnapshot?: { prepares?: boolean; templateKey?: string; resumeFrom?: string };
    admission?: PhysicalAdmissionTicket;
    /**
     * The other repositories of a multi-repository environment, each at the
     * claim's side's commit with that side's own token: sent only to a cell
     * whose hello names workspace. Never logged but by alias.
     */
    repos?: ClaimRepo[];
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

/**
 * A cell's text about a claim without any of the claim's download tokens
 * (its own repository's and every other one's), whatever the cell's own
 * redactor missed: what the hub records, logs and hands back never holds one.
 */
function withoutTokens<T>(value: T, req: Pick<AcquireInput, 'repoToken' | 'repos'>): T {
    const tokens = [req.repoToken ?? '', ...(req.repos ?? []).map((r) => r.repoToken)].filter((t) => t.length >= 8);
    const text = JSON.stringify(value);
    if (text === undefined || !tokens.some((t) => text.includes(t))) return value;
    let out = text;
    for (const t of tokens) out = out.split(t).join('[redacted:repo_token]');
    return JSON.parse(out) as T;
}

/** What a claim of a Run, a setup or a session downloads; only a sandbox claim has none. */
function requireRepo(req: AcquireInput): { repo: RepoRef; repoToken: string } {
    if (!req.repo || !req.repoToken) throw new Error(`a ${req.consumer} claim needs its repository and download token`);
    return { repo: req.repo, repoToken: req.repoToken };
}

/**
 * Why a claim that never reported ready stopped at the hub's wait: the boot
 * outlived it. The wait is the consumer's (a setup's 45 min, a Run's 30), so
 * the words name whose; "the most a setup waits" on a Run's claim (calcom,
 * 2026-11-13) sent the owner to the wrong limit. A build the cell ran with no
 * state, because its disk floor had evicted it, says that too: that is why it
 * was long, and a new setup is what restores it.
 */
export function bootTimeoutMessage(waitedMs: number, consumer: AcquireInput['consumer'], buildStateEvictedAt?: string): string {
    const minutes = Math.round(waitedMs / 60_000);
    const whose = consumer === 'setup' ? 'the most a setup waits' : 'the most a boot of this claim waits';
    const why = buildStateEvictedAt
        ? `; it built with no cache: the cell removed this environment's build cache to free disk at ${buildStateEvictedAt}, and a new setup restores it`
        : '';
    return `the boot did not finish in ${minutes} min, ${whose}${why}`;
}

/**
 * A Run's PR side builds the pull request's commit on the environment's build
 * state (readyTimeoutMinutes). On a cell whose disk floor evicted that state
 * and no setup made it again (runtime_build_state_evictions), the build runs
 * cold: calcom's never booted and held a 16 GB cell for its whole 30 min wait
 * (measured on the dev cell, 2026-11-13). Refused before anything is taken or sent when
 * that cold build would pass the wait: the cell measured the build that made
 * the state (rebuildSeconds) at the wait or longer, or never measured it (a
 * cell that cannot say, or a state older than the measure). Since the cell
 * exports a cache at each seeding setup, a state it measured under the wait
 * boots. The Run ends partly tested with a platform blocker that names the
 * setup as the fix, never as the PR's failure (architecture review P3).
 */
export function evictedStateRefusal(evicted: EvictedBuildStateRow | null, waitMs: number): Blocked | undefined {
    if (!evicted) return undefined;
    if (evicted.rebuildSeconds !== undefined && evicted.rebuildSeconds * 1000 < waitMs) return undefined;
    return buildStateEvictedBlocker(evicted.evictedAt, evicted.rebuildSeconds, waitMs);
}

export function buildStateEvictedBlocker(evictedAt: string, rebuildSeconds?: number, waitMs?: number): Blocked {
    const cost = rebuildSeconds !== undefined && waitMs !== undefined
        ? `; its last build with no cache took ${Math.round(rebuildSeconds / 60)} min and a pull request's boot waits ${Math.round(waitMs / 60_000)} min`
        : '';
    return {
        status: 'blocked',
        blockers: [
            {
                kind: 'platform',
                signature: 'build_state_evicted',
                message: `the cell removed this environment's build cache to free disk at ${evictedAt} and no setup restored it since${cost}; the pull request would build with no cache, past its boot's wait. Run the setup again`,
            },
        ],
        buildStateEvictedAt: evictedAt,
    };
}

const released = (): Blocked => ({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'claim_released', message: 'this claim was already released' }] });

/** The cell's nack code for a claim it has no room for (a slot or its memory). */
export const NO_CAPACITY = 'no_capacity';

/**
 * No room for the claim on the cell now: nothing was started, and
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
    /** What the cells this replica holds may still take, by memory. */
    readonly memory = new CellMemoryBook();
    /** The environment's approved egress hosts, to the claims that may have them. */
    readonly egress: ClaimEgressService;

    constructor(
        private readonly store: HubStore,
        private readonly connections: CellConnectionRegistry,
        private readonly metrics: RuntimeMetrics,
        private readonly hubMetrics: HubMetrics,
        private readonly log: HubLog,
        private readonly opts: { readyTimeoutMs?: number; now: () => Date; machineMinutes?: MachineMinuteBudget; secrets?: OrgSecretRefs; sandboxMemoryMb?: number },
    ) {
        this.egress = new ClaimEgressService(store, connections, log, () => this.opts.now());
    }

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
            this.log('info', 'claim.transition', { ...ids, to, reason: cause.reason, ...(cause.detail ? { detail: telemetryDetail(cause.detail) } : {}) });
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
        if (!claim || claim.cellId !== cellId || !isClaimStateIn(MACHINE_HOLDING_CLAIM_STATES, claim.state)) {
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
        // A preview claim's event is counted where=preview (docs/runtime/preview-urls.md §5.3): the worker stops the preview on it.
        this.metrics.recordSecurityEvent({ orgId: claim.orgId, kind: 'exfiltration', where: claim.consumer === 'preview' ? 'preview' : claim.side });
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
     * patterns (the cell's claim redactor ran first). Never fails the
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
        if (joined !== undefined) {
            this.log('info', 'claim.acquire.joined', { cellId, claimId, runId: req.runId });
            return joined;
        }
        const round = inSpan('runtime.hub.claim.acquire', { 'runtime.cell.id': cellId, 'runtime.claim.id': claimId, 'runtime.claim.side': req.ref.side }, () =>
            this.acquireRound(cellId, claimId, req),
        ).finally(() => this.inFlight.delete(claimId));
        this.inFlight.set(claimId, round);
        return round;
    }

    /**
     * One acquire round: the checks before anything is taken, the cell's
     * memory, this round recorded (a retry rebinds the claim), then the
     * claim.acquire and its claim.ready or claim.failed.
     */
    private async acquireRound(cellId: string, claimId: string, req: AcquireInput): Promise<Claim | Blocked> {
        const session = await this.store.session(cellId);
        if (!session) throw new CellUnavailableError(cellId);
        if (session.owner === 'customer' && session.orgId !== req.organizationId) {
            // Claims of an org only go to that org's cells or to managed cells.
            this.metrics.recordProtocolViolation({ cellId, code: 'cross_org_claim' });
            throw new ClaimScopeError('cell does not serve this organization');
        }
        const conn = this.connections.require(cellId);
        const at = this.now().getTime();
        const ids = { cellId, claimId, runId: req.runId, orgId: req.organizationId, environmentId: req.environmentId };
        const refused = await this.refusalBeforeAdmission(session, ids, req);
        if (refused) return refused;
        const overBudget = await this.reserveMachineMinutes(ids, req);
        if (overBudget) return overBudget;
        // Until the claim.acquire goes out, every way out gives the round's minutes back.
        const giveBack = () => this.opts.machineMinutes?.store.cancel(claimId).catch((e: unknown) => this.log('warn', 'claim.machine_minutes_cancel_failed', { ...ids, error: (e as Error).message }));
        const admitted = this.admitMemory(session, ids, req, at);
        if ('status' in admitted) {
            await giveBack();
            return admitted;
        }
        let deadlines: ClaimDeadlines | Blocked;
        try {
            deadlines = await this.recordRound(cellId, claimId, req, at, ids, admitted.metering);
        } catch (e) {
            this.memory.forget(cellId, claimId);
            await giveBack();
            throw e;
        }
        if ('status' in deadlines) {
            this.memory.forget(cellId, claimId);
            await giveBack();
            return deadlines;
        }
        return this.sendAndAwaitReady(conn, session, ids, req, at, deadlines);
    }

    /**
     * The org's machine minutes for this round: its consumer's whole ceiling,
     * reserved before the cell's memory is taken or anything is recorded or
     * sent. A day that cannot hold it refuses the claim (machine_minutes_exhausted);
     * the round counts what it held once its claim ends (pg-machine-minutes.store.ts).
     */
    private async reserveMachineMinutes(ids: ClaimIds & { orgId: string }, req: AcquireInput): Promise<Blocked | undefined> {
        const budget = this.opts.machineMinutes;
        if (!budget) return undefined;
        const decision = await budget.store.reserve({ claimId: ids.claimId, organizationId: req.organizationId, needSeconds: claimCeilingSeconds(req.consumer), limitMinutes: budget.limitMinutes });
        if (decision.allowed === false) {
            this.log('warn', 'claim.machine_minutes_exhausted', { ...ids, consumer: req.consumer, spentMinutes: decision.spentMinutes, limitMinutes: decision.limitMinutes, needMinutes: decision.needMinutes });
            return machineMinutesExhausted(decision);
        }
        return undefined;
    }

    /**
     * What refuses the claim before anything is taken, recorded or sent: an
     * isolation the cell does not satisfy, a recipe the cell cannot read, an
     * admission ticket that is required or no longer valid, a machine size the
     * cell does not grant, authored files the cell cannot write.
     */
    private async refusalBeforeAdmission(session: CellSession, ids: ClaimIds & { orgId: string }, req: AcquireInput): Promise<Blocked | undefined> {
        const { cellId, claimId } = ids;
        if (!isolationSatisfies(session.isolation, req.isolation)) {
            // Never placed lower: the worker routes the claim to a cell that satisfies it, so
            // this cell changed since, or the claim came through a path that does not route by it.
            this.log('warn', 'claim.isolation_unavailable', { ...ids, isolation: req.isolation, cellIsolation: session.isolation ?? null });
            return isolationUnavailable(req.isolation!, 'this cell');
        }
        // Older cells must not silently ignore executable recipe fields.
        const recipeBlocker = recipeCapabilityBlocker(session, req.recipe);
        if (recipeBlocker) {
            this.log('warn', 'claim.recipe_capability_refused', { cellId, claimId, runId: req.runId, signature: recipeBlocker.blockers[0].signature });
            return recipeBlocker;
        }
        if (!req.admission && this.memory.ticketMemberReserved(cellId, claimId)) {
            return {
                status: 'blocked',
                blockers: [{ kind: 'platform', signature: 'admission_ticket_required', message: 'this claim belongs to a physical admission ticket' }],
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
                blockers: [{ kind: 'platform', signature: 'admission_ticket_invalid', message: 'the physical admission ticket is no longer valid; Run again' }],
            };
        }
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
        if (req.consumer === 'sandbox' && !supports(session, 'sandbox')) {
            // Nothing was sent or recorded: the worker picks a cell that names it.
            this.log('warn', 'claim.sandbox_unsupported', ids);
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'sandbox_unsupported', message: 'this cell runs no code sandboxes' }] };
        }
        if (req.consumer === 'preview' && !supports(session, 'preview')) {
            // Nothing was sent or recorded: a cell without the feature never routes the preview.
            this.log('warn', 'claim.preview_unsupported', ids);
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'preview_unsupported', message: 'this cell serves no previews' }] };
        }
        if ((req.sandboxSnapshot?.prepares || req.sandboxSnapshot?.resumeFrom) && !supports(session, 'snapshots')) {
            // A template or a session lives on a cell that keeps memory snapshots; a
            // templateKey alone is only a hint and goes to no cell that cannot read it.
            this.log('warn', 'claim.snapshots_unsupported', ids);
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'snapshot_unsupported', message: 'this cell keeps no memory snapshot' }] };
        }
        if (req.repos?.length && !supports(session, 'workspace')) {
            // A cell that cannot fetch them would boot the claim's own repository alone, which is not the system.
            this.log('warn', 'claim.workspace_unsupported', { ...ids, repos: req.repos.map((r) => r.alias) });
            return workspaceUnsupported(req.repos.map((r) => r.alias));
        }
        if (req.consumer === 'runtime' && req.ref.side === 'pr') {
            const evicted = await this.evictedBuildState(cellId, req);
            const refusal = evictedStateRefusal(evicted, readyTimeoutMinutes(req.consumer, req.ref.side) * 60_000);
            if (refusal) {
                this.log('warn', 'claim.build_state_evicted', { ...ids, evictedAt: evicted!.evictedAt, rebuildSeconds: evicted!.rebuildSeconds ?? null });
                return refusal;
            }
        }
        return undefined;
    }

    /**
     * The cell's memory for the claim, checked and taken with no await in
     * between, before anything is recorded or sent; and what this round holds,
     * recorded with it once (the Run's cost is priced from it).
     */
    private admitMemory(session: CellSession, ids: ClaimIds & { orgId: string }, req: AcquireInput, at: number): Blocked | { metering: ClaimMetering } {
        const { cellId, claimId } = ids;
        const siblingKeys = siblingKeysOf(req.runId, req.idempotencyKey);
        const sizeMb = this.sizeMbOf(session, req);
        const fit = this.memory.admit(
            cellId,
            { claimId, runId: req.runId, side: req.ref.side, consumer: req.consumer, sizeMb, ...(siblingKeys.length ? { siblingClaimIds: siblingKeys.map((k) => claimIdFor(req.organizationId, k)) } : {}) },
            at,
        );
        if (fit.kind === 'too_large') {
            this.log('warn', 'claim.memory_unavailable', { ...ids, needMb: fit.needMb, allocatableMb: fit.allocatableMb });
            return memoryUnavailable(fit);
        }
        if (fit.kind === 'wait') {
            this.hubMetrics.claimCapacityWait({ consumer: req.consumer });
            this.log('info', 'claim.no_capacity', { ...ids, side: req.ref.side, consumer: req.consumer, needMb: fit.needMb, freeMb: fit.freeMb, allocatableMb: fit.allocatableMb, ahead: fit.ahead });
            const why = fit.ahead ? `${fit.ahead} claim(s) asked this cell first and still wait` : `the claim needs ${fit.needMb} MB of memory and ${fit.freeMb} of the cell's ${fit.allocatableMb} MB are free`;
            // A sandbox does not wait in the cell's line (cell-memory.ts): its caller opens another later.
            const then = req.consumer === 'sandbox' ? 'open the sandbox again later' : 'the claim waits for room';
            return noCapacity(cellId, `${why}; nothing was started, ${then}`, fit);
        }
        if (fit.kind === 'admitted') this.log('info', 'claim.memory_admitted', { ...ids, side: req.ref.side, needMb: fit.needMb, siblingMb: fit.siblingMb });
        const sizes = fit.kind === 'admitted' ? this.memory.sizesOf(cellId, { side: req.ref.side, consumer: req.consumer, sizeMb }) : null;
        if (sizes && req.admission) sizes.bootMb = this.memory.ticketOf(req.admission)?.bootMb ?? sizes.bootMb;
        // The vCPUs the claim runs with (the usage report's vCPU·min): its size's, else (a sandbox)
        // the cell's sandbox size's, else the cell's default size's when its hello says it; none
        // from a cell that does not.
        const cpus = req.size?.cpus ?? (req.consumer === 'sandbox' ? session.sandboxClaimSize?.cpus : undefined) ?? session.defaultClaimSize?.cpus;
        return {
            metering: {
                driver: session.driver,
                bootMb: sizes?.bootMb ?? null,
                readyMb: sizes?.readyMb ?? null,
                allocatableMb: sizes?.allocatableMb ?? null,
                ...(cpus ? { cpus } : {}),
            },
        };
    }

    /**
     * The memory the claim is admitted at: its size's; for a code sandbox that
     * asks none, the cell's sandbox size (hello capabilities.sandboxSize), else
     * the hub's (RUNTIME_SANDBOX_MEMORY_MB), never the cell's default Run size
     * (the dev cell admitted a sandbox at 12288 MB while its blank commits 2048).
     * Undefined: the cell's default.
     */
    private sizeMbOf(session: CellSession, req: AcquireInput): number | undefined {
        if (req.size) return req.size.memoryMb;
        if (req.consumer !== 'sandbox') return undefined;
        return session.sandboxClaimSize?.memoryMb ?? this.opts.sandboxMemoryMb ?? DEFAULT_SANDBOX_MEMORY_MB;
    }

    /**
     * The claim.acquire of a recorded round and what the cell answers: the ack
     * only means "accepted"; the claim is bound on claim.ready and fails on
     * claim.failed.
     */
    private async sendAndAwaitReady(conn: CellConnection, session: CellSession, ids: ClaimIds & { orgId: string; environmentId: string }, req: AcquireInput, at: number, deadlines: ClaimDeadlines): Promise<Claim | Blocked> {
        const { cellId, claimId } = ids;
        const { leaseExpiresAt, hardExpiresAt } = deadlines;
        // A new round: what the cell settled for this claimId before no longer answers it.
        this.settledClaimOutcomes.delete(claimId);
        // From claim.acquire to claim.ready (machines, code, observer), never past the claim's ceiling.
        const ready = this.awaitReady(conn, claimId, readyWaitMs(req.consumer, deadlines, at, req.ref.side));
        // A diagnostic hold is only ever asked for a setup claim that is not a PR.
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
            // The other repositories by alias and commit; their tokens never reach a log line.
            ...(req.repos?.length ? { repos: req.repos.map((r) => `${r.alias}@${r.sha.slice(0, 12)}`) } : {}),
        });
        // The approved hosts travel with the acquire: a build that starts at once (a Dockerfile's
        // apk add) already has them. Unreadable, a cell that cannot decode the field, or the PR side
        // of a fork: the claim starts on the base list, and the push after ready (or a later approval)
        // still reaches a claim that may have them.
        const approvals = receivesApprovedHosts({ side: req.ref.side, forkPullRequest: req.forkPullRequest });
        const egress = req.consumer === 'sandbox'
            ? await this.egress.sandboxEgressOf(req.organizationId, req.sandboxEgress ?? [], ids)
            : approvals && supports(session, 'egressAllow') ? await this.egress.approvedEgressOf(req.organizationId, req.environmentId, ids) : { allow: [], inspect: [] };
        const egressAllow = egress.allow;
        // Feature egressTiers: the approvals made as inspected, and the org's switch for the Kodus
        // recommended list (D2), sent only when it is off. A fork's PR side gets no approval but keeps the list.
        const tiers = supports(session, 'egressTiers');
        const recommendedOff = tiers && !(await this.egress.recommendedEnabledOf(req.organizationId, ids));
        const egressTiers = {
            ...(tiers && egress.inspect.length ? { egressInspect: egress.inspect } : {}),
            ...(recommendedOff ? { egressRecommended: false } : {}),
        };
        // The Run's decoys, to a cell that plants them; never logged here. A cell that
        // cannot read the field plants none, and the worker still checks every boundary for them.
        const canaries = req.consumer !== 'setup' && req.canaries?.length && supports(session, 'canaries') ? req.canaries.map((c) => ({ slot: c.slot, value: c.value })) : [];
        // The Run's drawn identifiers (S-36), to a cell that sets them; the claim says whether it did.
        const identity = runIdentityFor(session, req);
        // The org's secrets by reference, to a cell that gives each a placeholder; never their value.
        const secrets = await this.secretsFor(session, req, ids);
        // Another cell's bakes of the environment, to a cell that pulls them; never to a setup.
        const sharedImages = await this.sharedImagesFor(session, req, ids);
        let reply: Envelope;
        try {
            if (req.admission && (!(await this.tickets!.authorizeAcquire(req.admission, req)) || !this.tickets!.consume(req.admission, claimId)))
                throw new CellUnavailableError('the physical admission ticket is no longer valid');
            reply = req.consumer === 'sandbox'
                ? await this.connections.request(
                      cellId,
                      'sandbox.acquire',
                      {
                          orgId: req.organizationId,
                          hardExpiresAt,
                          leaseExpiresAt,
                          ...(egressAllow.length ? { egressAllow } : {}),
                          ...egressTiers,
                          ...(req.size ? { size: { memoryMb: req.size.memoryMb, cpus: req.size.cpus } } : {}),
                          ...(secrets.length ? { secrets } : {}),
                          ...sandboxSnapshotFields(req.sandboxSnapshot, supports(session, 'snapshots')),
                      },
                      claimId,
                  )
                : await this.connections.request(
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
                    repo: requireRepo(req).repo,
                    repoToken: requireRepo(req).repoToken,
                    expose: req.expose,
                    hardExpiresAt,
                    leaseExpiresAt,
                    ...(hold ? { diagnosticHold: true } : {}),
                    ...(seedsCache ? { seedsCache: true } : {}),
                    ...(req.recipe ? { recipe: claimRecipe(req.recipe) } : {}),
                    ...(egressAllow.length ? { egressAllow } : {}),
                    ...egressTiers,
                    // The environment's machine size, which the cell grants (checked above).
                    ...(req.size ? { size: { memoryMb: req.size.memoryMb, cpus: req.size.cpus } } : {}),
                    ...(canaries.length ? { canaries } : {}),
                    ...(identity ? { identity } : {}),
                    // Only to a cell whose hello names workspace (refused before admission otherwise).
                    ...(req.repos?.length ? { repos: req.repos.map((r) => ({ alias: r.alias, repo: r.repo, sha: r.sha, repoToken: r.repoToken })) } : {}),
                    ...(secrets.length ? { secrets } : {}),
                    ...(sharedImages.length ? { sharedImages } : {}),
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
        if (reply.type === 'blocked' || reply.type === 'nack') return this.refusedAcquire(ids, req, reply);
        return this.readyOutcome(session, ids, req, at, deadlines, hold, approvals, await ready);
    }

    /**
     * The environment's baked images another cell of the org pushed (runtime_shared_images), for a claim's builds
     * (feature bakeShare). A setup builds what the environment keeps and gets none. Unreadable: none, logged; the
     * cell builds as it would have.
     */
    private async sharedImagesFor(session: CellSession, req: AcquireInput, ids: ClaimIds & { orgId: string }): Promise<SharedImage[]> {
        if (req.consumer === 'setup' || !supports(session, 'bakeShare')) return [];
        try {
            return await this.store.sharedImages(req.organizationId, req.environmentId, MAX_SHARED_IMAGES);
        } catch (e) {
            this.log('warn', 'claim.shared_images.unread', { ...ids, error: (e as Error).message });
            return [];
        }
    }

    /**
     * The org's secrets a claim gets (docs/runtime/sandbox.md): a cell that
     * names the feature secrets; a claim that may have the org's approved
     * hosts (never the PR side of a fork: code nobody in the org wrote);
     * a sandbox only when its caller asked. Unreadable, the claim starts
     * without them, as with its approved hosts (logged).
     */
    private async secretsFor(session: CellSession, req: AcquireInput, ids: ClaimIds & { orgId: string }): Promise<ClaimSecret[]> {
        if (!this.opts.secrets || !supports(session, 'secrets')) return [];
        // A preview is someone driving the app by hand: no org secret unless an owner set its environment to "same as the Run" (decision 4).
        if (req.consumer === 'preview' && req.previewSecrets !== true) return [];
        if (req.consumer === 'sandbox' ? req.sandboxSecrets !== true : !receivesApprovedHosts({ side: req.ref.side, forkPullRequest: req.forkPullRequest })) return [];
        try {
            const secrets = await this.opts.secrets.secretsOf(req.organizationId);
            // Ids only: names and hosts are the org's configuration, the value is never here.
            if (secrets.length) this.log('info', 'claim.secrets', { ...ids, secrets: secrets.length });
            return secrets;
        } catch (e) {
            this.log('error', 'claim.secrets.unread', { ...ids, error: (e as Error).message });
            return [];
        }
    }

    /** The cell answered the claim.acquire with a blocker or a nack: the claim is blocked, and a nack for room waits. */
    private async refusedAcquire(ids: ClaimIds & { orgId: string }, req: AcquireInput, reply: Envelope): Promise<Blocked> {
        if (reply.type === 'blocked') {
            const b = withoutTokens(reply.body as MessageBody<'blocked'>, req);
            await this.move(ids, ['pending'], 'blocked', { reason: 'cell_blocked', detail: b.signature });
            await this.recordBootBlocker(ids, req.ref.side, { kind: b.kind, signature: b.signature, message: b.message });
            this.log('warn', 'claim.blocked', { ...ids, kind: b.kind, signature: blockerSignatureClass(b.signature) });
            const alias = memberAliasOfReason(b.message, req.repos);
            const blocker = { kind: b.kind, signature: b.signature, message: b.message, ...(alias ? { alias } : {}) };
            return { status: 'blocked', blockers: [blocker] };
        }
        const b = withoutTokens(reply.body as MessageBody<'nack'>, req);
        await this.move(ids, ['pending'], 'blocked', { reason: 'cell_refused', detail: b.code });
        this.log('warn', 'claim.acquire.nacked', { ...ids, code: b.code });
        // The cell's own ledger had no room (a slot, or memory the hub did not see yet): wait, never a failure.
        if (b.code === NO_CAPACITY) return noCapacity(ids.cellId, `the cell has no room for the claim now (${b.message}); nothing was started, ${req.consumer === 'sandbox' ? 'open the sandbox again later' : 'the claim waits for room'}`);
        return { status: 'blocked', blockers: [{ kind: 'platform', signature: b.code, message: b.message }] };
    }

    /** What an accepted claim.acquire became: bound on claim.ready, held or failed on claim.failed, failed when the cell never said. */
    private async readyOutcome(
        session: CellSession,
        ids: ClaimIds & { orgId: string; environmentId: string },
        req: AcquireInput,
        at: number,
        deadlines: ClaimDeadlines,
        hold: boolean,
        approvals: boolean,
        outcome: ReadyOutcome,
    ): Promise<Claim | Blocked> {
        const { cellId, claimId } = ids;
        const { leaseExpiresAt, hardExpiresAt } = deadlines;
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
                // The boot outlived the ceiling: stop it now instead of at the next heartbeat's reconcile (which sends it again if this one is lost).
                void this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
                const evicted = await this.buildStateEvictedAt(cellId, req);
                return {
                    status: 'blocked',
                    blockers: [{ kind: 'resources', signature: 'boot_timeout', message: bootTimeoutMessage(waitedMs, req.consumer, evicted) }],
                    cellId,
                    ...(evicted ? { buildStateEvictedAt: evicted } : {}),
                };
            }
            if (outcome.why === 'disconnected') {
                return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'cell_lost', message: 'the cell disconnected while the claim was booting' }] };
            }
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'claim_not_ready', message: 'the cell did not report the claim ready' }] };
        }
        if (outcome.type === 'failed') {
            const { kind, signature, reason, bundle, held, phases } = withoutTokens(outcome.body, req);
            // A member repository's failure names it at the start of the reason: the blocker carries its alias.
            const alias = memberAliasOfReason(reason, req.repos);
            const blocker = { kind, signature, message: reason, ...(bundle ? { bundle } : {}), ...(alias ? { alias } : {}), ...(phases?.length ? { phases } : {}) };
            const detail = `${kind}/${signature}`;
            // Recorded before the claim moves on, held or failed: the proof outlives the cell's cleanup.
            await this.recordBootBlocker(ids, req.ref.side, blocker);
            if (held && hold && (await this.move(ids, ['pending'], 'held', { reason: 'held_for_diagnosis', detail }))) {
                // The cell kept the machines: exec and release only, until hardExpiresAt.
                this.log('warn', 'claim.held', { ...ids, kind, signature, waitedMs, hardExpiresAt });
                return { status: 'blocked', blockers: [blocker], held: { claimId, cellId, hardExpiresAt }, cellId };
            }
            await this.move(ids, ['pending'], 'failed', { reason: 'boot_failed', detail });
            const evicted = await this.buildStateEvictedAt(cellId, req);
            this.log('warn', 'claim.failed', { ...ids, kind, signature: blockerSignatureClass(signature), waitedMs, ...(phases?.length ? { slowestPhases: phases.slice(0, 3).map((p) => `${telemetryPhaseName(p.name)}:${p.ms}`) } : {}) });
            return { status: 'blocked', blockers: [blocker], cellId, ...(evicted ? { buildStateEvictedAt: evicted } : {}) };
        }
        const start = outcome.body.start;
        if (!(await this.move(ids, ['pending'], 'bound', { reason: 'ready', ...(start ? { start } : {}) }))) {
            // Released (or rebound elsewhere) while the cell was booting: the machines go back.
            this.log('warn', 'claim.ready_after_release', { ...ids, waitedMs });
            // A release the cell does not ack is sent again by the next heartbeat's reconcile: the claim is no longer live here.
            await this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
            return released();
        }
        const { manifest, observer, timing } = outcome.body;
        // The phases as numbers; the build steps (names) go with the claim to the Run, not into this line.
        const { buildSteps, phases: named, ...phases } = timing ?? { prepareMs: 0 };
        this.log('info', 'claim.ready', {
            ...ids,
            waitedMs,
            ...(timing ? phases : {}),
            // Where the boot went, in words (claim.ready timing.phases): the slowest few.
            // A phase named from a Dockerfile line is repository text: telemetry says "build step" (telemetryPhaseName).
            ...(named?.length ? { slowestPhases: named.slice(0, 3).map((p) => `${telemetryPhaseName(p.name)}:${p.ms}`) } : {}),
            ...(buildSteps ? { buildSteps: buildSteps.steps, buildStepsCached: buildSteps.cached, slowestBuildStepMs: buildSteps.slowest[0]?.ms ?? 0 } : {}),
            services: manifest.services.length,
            seedSha: manifest.seedSha,
        });
        this.hubMetrics.claimBootPhases(timing, { consumer: req.consumer, driver: session.driver });
        this.hubMetrics.claimExport(named, { consumer: req.consumer, driver: session.driver });
        this.hubMetrics.claimStarted(start, { consumer: req.consumer });
        // A claim created after an approval gets the environment's approved hosts now, not only the base list.
        if (approvals && req.consumer !== 'sandbox') await this.egress.pushApprovedHosts(cellId, claimId, req.organizationId, req.environmentId, ids);
        // A boot that built on a cell which had evicted the environment's build state ran cold: the Run says so.
        const evicted = timing?.buildMs ? await this.buildStateEvictedAt(cellId, req) : undefined;
        return {
            claimId,
            cellId,
            cellOwner: session.owner,
            ...(session.features?.includes('browserExplore') ? { capabilities: { browserExplore: 'v1' as const } } : {}),
            ...withRunIdentity(runIdentityFor(session, req)),
            leaseExpiresAt,
            hardExpiresAt,
            observer: { id: observer.id, state: observer.state },
            manifest: { services: manifest.services, expose: manifest.expose, imageId: manifest.imageId, seedSha: manifest.seedSha },
            ...(timing ? { timing } : {}),
            ...(evicted ? { buildStateEvictedAt: evicted } : {}),
        };
    }

    /** The cell's eviction row for this environment, with its rebuild cost; a store that fails says nothing (the claim boots). */
    private async evictedBuildState(cellId: string, req: AcquireInput): Promise<EvictedBuildStateRow | null> {
        try {
            return await this.store.evictedBuildState(cellId, req.organizationId, req.environmentId);
        } catch (e) {
            this.hubMetrics.backgroundError('build_state_evictions');
            this.log('warn', 'claim.build_state_eviction.unread', { cellId, error: (e as Error).message });
            return null;
        }
    }

    /** When the cell evicted this environment's build state (runtime_build_state_evictions); a store that fails says nothing. */
    private async buildStateEvictedAt(cellId: string, req: AcquireInput): Promise<string | undefined> {
        try {
            return (await this.store.evictedBuildStateAt(cellId, req.organizationId, req.environmentId)) ?? undefined;
        } catch (e) {
            this.hubMetrics.backgroundError('build_state_evictions');
            this.log('warn', 'claim.build_state_eviction.unread', { cellId, error: (e as Error).message });
            return undefined;
        }
    }

    /**
     * Records this round of the claim, pending on `cellId`, and returns the
     * deadlines its claim.acquire carries. A claim already released answers
     * claim_released; a compromised one answers its violation and is never
     * rebound (its machines stay as evidence until it is released).
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
    private async recordRound(cellId: string, claimId: string, req: AcquireInput, at: number, ids: ClaimIds, metering: ClaimMetering): Promise<ClaimDeadlines | Blocked> {
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
            forkPullRequest: req.forkPullRequest === true,
            ...fresh,
        });
        if (inserted) return fresh;
        const existing = await this.store.claim(claimId);
        if (!existing || isFinalClaimState(existing.state)) return released();
        if (existing.environmentId && existing.environmentId !== req.environmentId) throw new ClaimScopeError('the claim belongs to another environment');
        if (existing.state === 'compromised') {
            this.log('warn', 'claim.rebind_refused', { ...ids, previousState: existing.state });
            const signature = (await this.violationOf(claimId)) ?? 'unknown';
            return { status: 'blocked', blockers: [{ kind: 'security_violation', signature, message: 'the cell reported a security violation on this claim; it is kept as evidence and never acquired again' }] };
        }
        // A round the cell refused for room never ran there: the claim starts its lifetime now.
        const neverRan = existing.state === 'blocked' && existing.reasonDetail === NO_CAPACITY;
        const deadlines = retryDeadlines(neverRan ? { ...existing, cellId: '' } : existing, cellId, fresh, at);
        if (!(await this.store.rebindClaim(claimId, { cellId, ...deadlines, metering }))) return released();
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
     * The machine time of a claim this replica just released, as the usage
     * report counts it (claimMbMinutes, claimHeldMinutes): a claim without its
     * metering facts counts nothing, never a guess.
     */
    private countMachineTime(claim: ClaimRow) {
        const now = this.now();
        const usage = {
            claimId: claim.claimId,
            cellId: claim.cellId,
            side: claim.side,
            state: claim.state,
            driver: claim.metering?.driver ?? null,
            bootMb: claim.metering?.bootMb ?? null,
            readyMb: claim.metering?.readyMb ?? null,
            allocatableMb: claim.metering?.allocatableMb ?? null,
            cpus: claim.metering?.cpus ?? null,
            admittedAt: claim.admittedAt ?? null,
            readyAt: claim.readyAt ?? null,
            releasedAt: now.toISOString(),
            stateChangedAt: claim.stateChangedAt ?? null,
            hardExpiresAt: claim.hardExpiresAt,
        };
        const mb = claimMbMinutes(usage, now);
        const held = claimHeldMinutes(usage, now);
        const owner = this.connections.get(claim.cellId)?.cred.owner ?? 'kodus';
        this.hubMetrics.machineTime({ gbMinutes: mb === null ? 0 : mb / 1024, ...(held !== null && usage.cpus ? { vcpuMinutes: held * usage.cpus } : {}) }, { consumer: claim.consumer, owner, orgId: claim.orgId });
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
        if (moved) this.countMachineTime(claim);
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
            // The cell's lease, dead-man and the reaper clean it up.
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
            if (row && row.cellId === cellId && isClaimStateIn(MACHINE_HOLDING_CLAIM_STATES, row.state)) continue;
            this.hubMetrics.claimReconciled();
            this.log('warn', 'claim.reconciled_release', { cellId, claimId, state: row?.state ?? 'unknown' });
            // Not awaited: the heartbeat's frame chain never waits on a cell's ack. A lost one is sent again on the next heartbeat that reports the claim.
            void this.connections.request(cellId, 'claim.release', {}, claimId).catch(() => undefined);
        }
        const reportedIds = new Set(reported.map((r) => r.claimId));
        for (const c of live.values()) {
            if (c.state === 'bound' && !reportedIds.has(c.claimId)) this.log('warn', 'claim.missing_on_cell', { cellId, claimId: c.claimId, runId: c.runId ?? undefined });
        }
    }
}

/** sandbox.acquire's snapshot fields, to a cell that names snapshots only (a templateKey alone is dropped elsewhere: the sandbox boots cold). */
function sandboxSnapshotFields(s: AcquireInput['sandboxSnapshot'], cellKeepsSnapshots: boolean): { prepares?: true; templateKey?: string; resumeFrom?: string } {
    if (!s || !cellKeepsSnapshots) return {};
    if (s.resumeFrom) return { resumeFrom: s.resumeFrom };
    return { ...(s.prepares ? { prepares: true as const } : {}), ...(s.templateKey ? { templateKey: s.templateKey } : {}) };
}

/**
 * The Run's drawn identifiers a claim carries (S-36): a Run's claim on a cell
 * that names runIdentity, never a setup's (its workload may be baked) nor an
 * older cell's (its strict decoder refuses the field). The Claim says the
 * same, so the probes expect the values only where the cell set them.
 */
function runIdentityFor(session: CellSession, req: AcquireInput): ClaimRunIdentity | undefined {
    if (req.consumer !== 'runtime' || !req.identity || !supports(session, 'runIdentity')) return undefined;
    return { hostname: req.identity.hostname, user: req.identity.user, domain: req.identity.domain };
}

const withRunIdentity = (identity: ClaimRunIdentity | undefined) => (identity ? { identity } : {});
