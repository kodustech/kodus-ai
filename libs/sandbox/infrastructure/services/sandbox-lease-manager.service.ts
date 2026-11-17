import { createLogger } from '@libs/core/log/logger';
import {
    AcquireResult,
    assertValidPrKey,
    ISandboxLeaseManager,
    SandboxCircuitOpenError,
    DEFAULT_CAPACITY_WAIT_MS,
    SandboxAcquireOptions,
    SandboxWaitAbortedError,
    SandboxInvalidatedError,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunOptions,
    SANDBOX_PROVIDER_TOKEN,
    toBranchName,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';
import { randomUUID } from 'crypto';

import { SandboxLeaseRepository } from '../repositories/sandbox-lease.repository';
import {
    DEFAULT_SANDBOX_CIRCUIT_OPTIONS,
    isRepositorySpecificSandboxFailure,
    isSandboxCapacityFailure,
    isTimeoutSandboxFailure,
    SandboxCircuitTransition,
    SandboxCreateCircuitBreaker,
} from './sandbox-create-circuit-breaker';
import { SandboxConcurrencyLimiter } from './sandbox-concurrency-limiter';
import {
    BackoffOptions,
    calculateBackoffInterval,
} from '@libs/common/utils/polling';
import {
    DEFAULT_SANDBOX_CONCURRENCY_LIMITS,
    ISandboxConcurrencyConfigService,
    SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN,
} from './sandbox-concurrency-config.service';
import { SANDBOX_LEASE_CLEANUP_STATUS } from '../repositories/schemas/sandbox-lease.model';
import { NULL_SANDBOX_INSTANCE } from '../providers/null-sandbox.service';
import {
    buildE2BRemoteCommands,
    runE2BCommand,
    syncE2BSandboxRepo,
} from '../providers/e2b-sandbox.service';
import {
    isLocalSandboxPath,
    deleteLocalSandbox,
} from './local-sandbox-cleanup.service';

/**
 * Default idle timeout applied when the last lease on a sandbox is released.
 * After this window the E2B sandbox is paused automatically (not killed).
 * 5 minutes is generous enough for a second @kody comment in the same PR
 * to reuse the warm sandbox without paying cold-start.
 *
 * Callers (e.g. CreateSandboxStage for review) can override this via
 * `release(leaseId, { idleMs })` when a shorter window makes more sense for
 * their flow — review uses 30s because the agent's @kody flow either arrives
 * within seconds (warm reuse) or much later (well past the TTL anyway).
 */
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes — default for conversation flow

/**
 * Default lease TTL: 30 minutes. The reaper will clean up any lease whose
 * expiresAt has passed — this guards against crashed-worker leaks.
 */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * A concurrency slot whose lease was never released is dropped after this
 * long. Longer than the 105-min job timeout so a slow review keeps its slot.
 */
const CONCURRENCY_SLOT_STALE_MS = 2 * 60 * 60 * 1000;

// A slot granted faster than this did not really wait; not worth a log line.
const SLOT_WAIT_LOG_THRESHOLD_MS = 1_000;

/**
 * Cadence for a review waiting on capacity (a worker slot, or room in the
 * E2B plan): 5s, doubling to at most a minute, with jitter. Each tick
 * re-reads the cap (raising it frees the line at once) and logs the wait.
 */
const CAPACITY_WAIT_BACKOFF: BackoffOptions = {
    baseInterval: 5_000,
    maxInterval: 60_000,
};

// Grace window for in-flight tool calls before a detached sandbox is killed.
const INVALIDATE_DRAIN_MS = 60_000;

/**
 * How often to poll when waiting for a concurrent creator to finish.
 */
const POLL_INTERVAL_MS = 500;

/**
 * Maximum time to wait for a CREATING sandbox to become READY.
 * Exceeding this throws SandboxCreateTimeoutError.
 */
const MAX_POLL_WAIT_MS = 30_000; // 30 seconds

/**
 * Sandbox creation retry budget: the initial attempt plus ONE retry, 10s
 * apart. The old budget (3 attempts, 60s/120s backoffs, 5-min clone timeout)
 * could hold a review for ~18 minutes on a degraded proxy before it fell
 * back to self-contained mode.
 *
 * No retry at all for failures a retry cannot fix:
 * - repository-specific git errors (bad credentials, missing ref);
 * - timeouts, which already spent the whole clone budget on a slow network
 *   path and would spend it again.
 *
 * The provider call is the only thing wrapped — other lease operations
 * (Mongo upsert/update) are atomic and fast, so a retry there would mask
 * real errors instead of fixing them.
 */
const CREATE_MAX_ATTEMPTS = 2;
const CREATE_RETRY_DELAY_MS = 10_000;

/**
 * Thrown when polling for a CREATING sandbox exceeds MAX_POLL_WAIT_MS.
 * Callers should treat this as a signal to fall back to self-contained mode.
 */
export class SandboxCreateTimeoutError extends Error {
    constructor(prKey: string) {
        super(
            `SandboxLeaseManager: timed out waiting for sandbox to become READY for prKey="${prKey}"`,
        );
        this.name = 'SandboxCreateTimeoutError';
    }
}

/**
 * Thrown internally when Sandbox.connect() fails because the sandbox no
 * longer exists in E2B (idle-kill, reaper, or external termination). The
 * acquire() loop catches this, retries from scratch, and only surfaces it
 * if the cold-start retry also fails.
 */
export class SandboxStaleConnectionError extends Error {
    constructor(prKey: string, sandboxId: string) {
        super(
            `SandboxLeaseManager: stale sandbox connection — sandboxId="${sandboxId}" no longer exists for prKey="${prKey}"; lease cleaned, retry expected`,
        );
        this.name = 'SandboxStaleConnectionError';
    }
}

@Injectable()
export class SandboxLeaseManager implements ISandboxLeaseManager {
    private readonly logger = createLogger(SandboxLeaseManager.name);

    /**
     * Lease invariants:
     * - Only CREATING and READY leases are acquire targets; FAILED and
     *   INVALIDATED leases are rejected.
     * - Release/invalidate cleanup requires leaseCount <= 0; expired reaping
     *   force-cleans because the owning worker is presumed dead.
     * - Cleanup claims and deletes stay bound to the expected sandboxId and
     *   cleanup status so a replacement lease cannot remove another sandbox.
     */

    /**
     * In-memory map from leaseId → prKey.
     *
     * Multi-worker note: leaseId is generated and consumed inside the same
     * worker process — the pipeline that calls acquire() is the same one
     * that runs cleanup() at the end. So this Map does not need to be
     * shared across workers; it scopes correctly to the local lifetime
     * of a single review/conversation flow.
     */
    private readonly leaseIdToPrKey = new Map<string, string>();

    /**
     * Fails sandbox creation fast while the infrastructure is degraded —
     * see SandboxCreateCircuitBreaker. Per process, like leaseIdToPrKey.
     */
    readonly createCircuit = new SandboxCreateCircuitBreaker(
        DEFAULT_SANDBOX_CIRCUIT_OPTIONS,
        Date.now,
        (transition) => this.logCircuitTransition(transition),
    );

    /**
     * Per-process cap on sandboxes held at once, so the fleet stays inside the
     * E2B plan's concurrent-sandbox limit. Tuned through the
     * `sandbox_concurrency` global parameter; uncapped when it is absent.
     */
    readonly concurrencyLimiter = new SandboxConcurrencyLimiter(
        CONCURRENCY_SLOT_STALE_MS,
        Date.now,
        (slotId, heldMs) => {
            // The limiter no longer counts this slot: forget it, so the next
            // acquire on its prKey takes a new one instead of joining it
            for (const [prKey, slot] of this.prKeySlots) {
                if (slot.slotId === slotId) this.prKeySlots.delete(prKey);
            }
            this.logger.warn({
                message: `SandboxLeaseManager: dropped a sandbox slot held ${heldMs}ms without release`,
                context: SandboxLeaseManager.name,
                metadata: { slotId, heldMs },
            });
        },
    );
    /**
     * Slots are per sandbox, not per lease: the review, its safeguard pass
     * and a @kody reply on the same PR share one E2B sandbox, so they share
     * one slot. `granted` is shared so concurrent acquires on the same prKey
     * wait on one slot instead of taking two.
     */
    private readonly prKeySlots = new Map<string, WorkerSlot>();
    /** The slot each lease holds, kept even after the slot was dropped. */
    private readonly leaseIdToSlot = new Map<
        string,
        { prKey: string; slot: WorkerSlot }
    >();

    constructor(
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly leaseRepo: SandboxLeaseRepository,
        private readonly configService: ConfigService,
        // Optional so specs that build the manager by hand stay uncapped.
        @Optional()
        @Inject(SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN)
        private readonly concurrencyConfig?: ISandboxConcurrencyConfigService,
    ) {}

    /**
     * Acquire a lease (see acquireLease) once this worker has a concurrency
     * slot for the prKey's sandbox. With every slot taken the caller waits in
     * line for one, as long as it takes: a review never runs without its
     * sandbox for lack of capacity. Only `options.signal` (the job's) ends the
     * wait, with SandboxWaitAbortedError; a caller without one waits at most
     * DEFAULT_CAPACITY_WAIT_MS. The slot is held until the last lease this
     * worker holds on the prKey is released.
     */
    async acquire(
        prKey: string,
        consumer: string,
        leaseTtlMs = DEFAULT_LEASE_TTL_MS,
        cloneParams?: CreateSandboxParams,
        options?: SandboxAcquireOptions,
    ): Promise<AcquireResult> {
        assertValidPrKey(prKey);

        // No caller may wait forever: without the job's signal, bound it
        const bound = options?.signal ? null : new AbortController();
        const boundTimer = bound
            ? setTimeout(() => bound.abort(), DEFAULT_CAPACITY_WAIT_MS)
            : null;
        const signal = options?.signal ?? bound!.signal;
        const takesSlot = !options?.replacesOwnSandbox;

        try {
            const slot = takesSlot
                ? await this.takeSlot(prKey, consumer, signal)
                : null;
            try {
                const result = await this.acquireLease(
                    prKey,
                    consumer,
                    leaseTtlMs,
                    cloneParams,
                    signal,
                );
                if (slot)
                    this.leaseIdToSlot.set(result.leaseId, { prKey, slot });
                return result;
            } catch (err) {
                if (slot) this.dropSlot(prKey, slot);
                throw err;
            }
        } finally {
            if (boundTimer) clearTimeout(boundTimer);
        }
    }

    /**
     * Join this worker's slot for prKey, or queue for a new one. Waits with
     * backoff ticks: each re-reads the cap from the global parameter and logs
     * the line's state, until the slot is granted or the signal aborts.
     */
    private async takeSlot(
        prKey: string,
        consumer: string,
        signal?: AbortSignal,
    ): Promise<WorkerSlot> {
        let limits =
            (await this.concurrencyConfig?.getLimits()) ??
            DEFAULT_SANDBOX_CONCURRENCY_LIMITS;

        let slot = this.prKeySlots.get(prKey);
        if (slot) {
            slot.refs++;
        } else {
            const slotId = randomUUID();
            slot = {
                slotId,
                refs: 1,
                granted: this.concurrencyLimiter.acquire(
                    slotId,
                    limits.maxPerWorker,
                ),
            };
            this.prKeySlots.set(prKey, slot);
        }

        const startedAt = Date.now();
        for (let attempt = 0; ; attempt++) {
            const outcome = await waitFor(
                slot.granted,
                calculateBackoffInterval(attempt, CAPACITY_WAIT_BACKOFF),
                signal,
            );
            const waitedMs = Date.now() - startedAt;

            if (outcome === 'granted') {
                if (waitedMs >= SLOT_WAIT_LOG_THRESHOLD_MS) {
                    this.logger.log({
                        message: `SandboxLeaseManager: sandbox slot granted after ${waitedMs}ms prKey="${prKey}" consumer="${consumer}"`,
                        context: SandboxLeaseManager.name,
                        metadata: {
                            prKey,
                            consumer,
                            waitedMs,
                            maxPerWorker: limits.maxPerWorker,
                            active: this.concurrencyLimiter.active,
                            waiting: this.concurrencyLimiter.waiting,
                        },
                    });
                }
                return slot;
            }

            if (outcome === 'aborted' || outcome === 'withdrawn') {
                this.dropSlot(prKey, slot);
                this.logger.warn({
                    message: `SandboxLeaseManager: stopped waiting for a sandbox slot after ${waitedMs}ms prKey="${prKey}" consumer="${consumer}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey, consumer, waitedMs, outcome },
                });
                throw new SandboxWaitAbortedError(
                    prKey,
                    waitedMs,
                    'a sandbox slot on this worker',
                );
            }

            // Still in line: apply a cap raised in the meantime, then report
            limits =
                (await this.concurrencyConfig?.getLimits()) ??
                DEFAULT_SANDBOX_CONCURRENCY_LIMITS;
            this.concurrencyLimiter.setLimit(limits.maxPerWorker);
            this.logger.warn({
                message: `SandboxLeaseManager: waiting for a sandbox slot (${waitedMs}ms so far) prKey="${prKey}" consumer="${consumer}"`,
                context: SandboxLeaseManager.name,
                metadata: {
                    prKey,
                    consumer,
                    waitedMs,
                    attempt: attempt + 1,
                    maxPerWorker: limits.maxPerWorker,
                    active: this.concurrencyLimiter.active,
                    waiting: this.concurrencyLimiter.waiting,
                },
            });
        }
    }

    /**
     * Drop one reference to a slot; the last one frees it. The slot is passed
     * in, not looked up: one the limiter dropped as stale was replaced for its
     * prKey, and a late release must not decrement the replacement.
     */
    private dropSlot(prKey: string, slot: WorkerSlot): void {
        slot.refs--;
        if (slot.refs > 0) return;
        if (this.prKeySlots.get(prKey) === slot) this.prKeySlots.delete(prKey);
        this.concurrencyLimiter.release(slot.slotId);
    }

    /**
     * Acquire a lease for the given prKey, creating or reusing the sandbox.
     *
     * Concurrency semantics:
     * - leaseCount === 1 after upsertAcquire → we are the creator → call createSandboxWithRepo
     * - leaseCount >  1 and state === CREATING → another worker is creating → poll until READY
     * - leaseCount >= 1 and state === READY    → connect to existing sandbox
     * - state === INVALIDATED                  → throw immediately
     *
     * @param prKey      "{orgId}:{repoId}:{prNumber}"
     * @param consumer   Caller label for logging (e.g. 'review', 'conversation')
     * @param leaseTtlMs Lease document TTL (default 30 min); reaper cleans up expired docs
     * @param cloneParams Optional create params for plan 01-04 full pipeline integration.
     *                    In this plan acquire() calls createSandboxWithRepo only if the
     *                    provider is available; when absent the NULL_SANDBOX_INSTANCE is used.
     */
    private async acquireLease(
        prKey: string,
        consumer: string,
        leaseTtlMs = DEFAULT_LEASE_TTL_MS,
        cloneParams?: CreateSandboxParams,
        signal?: AbortSignal,
    ): Promise<AcquireResult> {
        // SECURITY: validate prKey shape BEFORE any Mongo / E2B side-effect.
        // A malformed key (missing UUID, extra ":" segments, etc.) MUST NOT
        // produce a lease — otherwise a bad caller could poison the
        // collection or accidentally cross-tenant.
        assertValidPrKey(prKey);

        this.logger.log({
            message: `SandboxLeaseManager: acquire prKey="${prKey}" consumer="${consumer}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer },
        });

        const doc = await this.leaseRepo.upsertAcquire(
            prKey,
            leaseTtlMs,
            consumer,
        );

        // Finding 1 fix: if cleanup is in progress, wait for it to complete
        // (doc will be deleted), then retry acquire from scratch. Prevents
        // attaching to a doc that's being cleaned up.
        if (doc.cleanupStatus === SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS) {
            // upsertAcquire() already incremented leaseCount on this doc. Undo
            // it BEFORE waiting: cleanup's claim requires leaseCount <= 0, so
            // holding the increment while we poll would deadlock the very
            // cleanup we're waiting on (and each retry would inflate the count
            // further). Mirrors the FAILED/INVALIDATED branches below.
            await this.leaseRepo.decrementLease(prKey);
            this.logger.log({
                message: `SandboxLeaseManager: cleanup in progress, waiting for completion prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey },
            });
            const deadline = Date.now() + MAX_POLL_WAIT_MS;
            while (Date.now() < deadline) {
                await sleep(POLL_INTERVAL_MS);
                const check = await this.leaseRepo.findByPrKey(prKey);
                if (!check) break; // Doc deleted — cleanup complete
            }
            // Retry acquire from scratch
            return this.acquireLease(
                prKey,
                consumer,
                leaseTtlMs,
                cloneParams,
                signal,
            );
        }

        if (doc.cleanupStatus === SANDBOX_LEASE_CLEANUP_STATUS.FAILED) {
            await this.leaseRepo.decrementLease(prKey);
            throw new Error(
                `SandboxLeaseManager: local cleanup previously failed for prKey="${prKey}"`,
            );
        }

        // Acquire-vs-invalidated race: upsertAcquire() already incremented
        // leaseCount, but the doc is INVALIDATED. Undo the increment so it
        // doesn't block cleanup. Do NOT delete the doc — a concurrent creator
        // may still need to observe the INVALIDATED state, and the reaper
        // handles stale doc cleanup. Throw so the caller knows the acquire
        // failed; the caller can retry with a fresh acquire if needed.
        if (doc.state === 'INVALIDATED') {
            const updated = await this.leaseRepo.decrementLease(prKey);
            this.logger.log({
                message: `SandboxLeaseManager: acquired INVALIDATED doc, decremented lease prKey="${prKey}" leaseCount=${updated?.leaseCount ?? 'unknown'}`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, leaseCount: updated?.leaseCount },
            });
            throw new SandboxInvalidatedError(prKey);
        }

        const leaseId = randomUUID();

        // A new acquire arrived — atomically clear any pending idle-kill so
        // the warm sandbox isn't killed under us between this call and
        // connect(). Multi-worker safe: any worker that reads the doc next
        // will see killAt=null and skip.
        await this.leaseRepo.clearKillAt(prKey);

        // --- Path A: We are the creator (we just inserted the doc) ---
        // Both conditions are required:
        //  - state === 'CREATING' is set only by $setOnInsert in upsertAcquire
        //    (a doc that already existed in READY/PAUSED won't have its state
        //    overwritten), so it filters out fresh acquires on existing leases.
        //  - leaseCount === 1 distinguishes "we just inserted" from "we joined a
        //    concurrent in-flight create" (where leaseCount would be > 1).
        // Without state === 'CREATING', a release-then-reacquire (count back to
        // 1 on an existing READY doc) would wrongly cold-create another sandbox
        // instead of warm-resuming the one already on the lease doc.
        if (doc.state === 'CREATING' && doc.leaseCount === 1) {
            return this.handleCreatorPath(
                prKey,
                leaseId,
                consumer,
                cloneParams,
                signal,
            );
        }

        // --- Path B: joiner — doc already existed or someone else is creating ---
        try {
            return await this.handleJoinerPath(
                prKey,
                leaseId,
                consumer,
                doc.state,
                doc.sandboxId,
                cloneParams,
            );
        } catch (err) {
            if (err instanceof SandboxStaleConnectionError) {
                // Lease referenced a sandbox that E2B no longer has (idle-
                // kill timer, reaper, or external termination). The
                // joiner path already deleted the stale lease — restart
                // acquire from scratch so this caller becomes the creator.
                this.logger.log({
                    message: `SandboxLeaseManager: re-acquiring after stale sandbox prKey="${prKey}" consumer="${consumer}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey, consumer },
                });
                return this.acquireLease(
                    prKey,
                    consumer,
                    leaseTtlMs,
                    cloneParams,
                    signal,
                );
            }
            throw err;
        }
    }

    /**
     * Release a lease. Decrements leaseCount atomically.
     *
     * When leaseCount reaches 0, schedules an idle-kill by writing
     * `killAt = now + idleMs` on the lease doc (via leaseRepo.setKillAt).
     * The `killIdleSandboxes` cron (any worker, coordinated via Postgres
     * advisory lock) picks up the doc once the timestamp elapses and
     * issues Sandbox.kill + delete. This makes idle-kill multi-worker safe
     * — no in-memory state required.
     *
     * `Sandbox.setTimeout(idleMs)` is also called as defence-in-depth: the
     * provider keeps `lifecycle: { onTimeout: 'pause' }`, so even if Mongo
     * is briefly unavailable for the cron, E2B itself pauses the sandbox
     * at the same idleMs window — billing stops; the reaper TTL pass picks
     * up the orphaned doc later.
     *
     * Callers choose `idleMs` based on the flow: review uses 30s because
     * @kody arrives within seconds or much later; conversation uses the
     * 5min default because the user is interactive.
     */
    async release(leaseId: string, opts?: { idleMs?: number }): Promise<void> {
        // Free the worker slot first: whatever happens to the lease doc
        // below, this process no longer holds the sandbox.
        const held = this.leaseIdToSlot.get(leaseId);
        if (held) {
            this.leaseIdToSlot.delete(leaseId);
            this.dropSlot(held.prKey, held.slot);
        }

        const prKey = this.leaseIdToPrKey.get(leaseId);
        if (!prKey) {
            this.logger.warn({
                message: `SandboxLeaseManager: release called with unknown leaseId="${leaseId}"`,
                context: SandboxLeaseManager.name,
                metadata: { leaseId },
            });
            return;
        }

        const updated = await this.leaseRepo.decrementLease(prKey);
        this.leaseIdToPrKey.delete(leaseId);

        this.logger.log({
            message: `SandboxLeaseManager: released leaseId="${leaseId}" prKey="${prKey}" leaseCount=${updated?.leaseCount ?? 'unknown'}`,
            context: SandboxLeaseManager.name,
            metadata: { leaseId, prKey, leaseCount: updated?.leaseCount },
        });

        if (updated && updated.leaseCount <= 0 && updated.sandboxId) {
            // Local sandbox: immediate cleanup
            if (isLocalSandboxPath(updated.sandboxId)) {
                const claimed = await this.leaseRepo.claimCleanup(
                    prKey,
                    updated.sandboxId,
                    true,
                );
                if (claimed) {
                    try {
                        await deleteLocalSandbox(updated.sandboxId);
                        await this.leaseRepo.completeCleanup(
                            prKey,
                            updated.sandboxId,
                        );
                        this.logger.log({
                            message: `SandboxLeaseManager: cleaned local sandbox sandboxId="${updated.sandboxId}" prKey="${prKey}"`,
                            context: SandboxLeaseManager.name,
                            metadata: {
                                prKey,
                                sandboxId: updated.sandboxId,
                            },
                        });
                    } catch (err) {
                        await this.leaseRepo.failCleanup(
                            prKey,
                            updated.sandboxId,
                            (err as Error).message,
                        );
                        this.logger.warn({
                            message: `SandboxLeaseManager: local cleanup failed, retry marker set sandboxId="${updated.sandboxId}"`,
                            context: SandboxLeaseManager.name,
                            error: err as Error,
                            metadata: {
                                prKey,
                                sandboxId: updated.sandboxId,
                            },
                        });
                    }
                }
                return;
            }

            // E2B path: existing idle-kill logic (unchanged)
            const idleMs = opts?.idleMs ?? IDLE_TIMEOUT_MS;
            const killAt = new Date(Date.now() + idleMs);
            await this.leaseRepo.setKillAt(prKey, killAt);

            this.logger.log({
                message: `SandboxLeaseManager: scheduled idle-kill at ${killAt.toISOString()} for sandboxId="${updated.sandboxId}"`,
                context: SandboxLeaseManager.name,
                metadata: {
                    prKey,
                    sandboxId: updated.sandboxId,
                    idleTimeoutMs: idleMs,
                    killAt,
                },
            });

            const apiKey = this.configService.get<string>('API_E2B_KEY');
            if (apiKey) {
                try {
                    await Sandbox.setTimeout(updated.sandboxId, idleMs, {
                        apiKey,
                    });
                } catch (err) {
                    this.logger.warn({
                        message: `SandboxLeaseManager: failed to set E2B-side idle timeout on sandboxId="${updated.sandboxId}" (kill cron is the primary path)`,
                        context: SandboxLeaseManager.name,
                        error: err,
                    });
                }
            }
        }
    }

    /**
     * Invalidate a lease for the given prKey, called on PR-close or force-push.
     *
     * - state === CREATING: mark as INVALIDATED; the in-flight create path will
     *   detect this and kill the sandbox after it finishes (preventing orphans).
     * - state === READY or PAUSED: soft-drain (60s setTimeout) then delete doc.
     * - doc not found: no-op (idempotent).
     */
    async invalidate(prKey: string): Promise<void> {
        this.logger.log({
            message: `SandboxLeaseManager: invalidate prKey="${prKey}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey },
        });

        // Clear any pending idle-kill so the cron doesn't double-kill —
        // invalidate already does its own kill via soft-drain + delete.
        await this.leaseRepo.clearKillAt(prKey);

        const doc = await this.leaseRepo.findByPrKey(prKey);
        if (!doc) {
            // Idempotent: no lease to invalidate
            this.logger.log({
                message: `SandboxLeaseManager: invalidate no-op (doc not found) prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey },
            });
            return;
        }

        if (doc.state === 'CREATING') {
            // Mid-create race: mark as INVALIDATED so the create path can detect and kill
            // Local sandbox: mark invalidated (cleanup on creator failure or final release)
            if (isLocalSandboxPath(doc.sandboxId)) {
                await this.leaseRepo.markInvalidated(prKey);
                this.logger.log({
                    message: `SandboxLeaseManager: marked INVALIDATED (mid-create, local) prKey="${prKey}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey },
                });
                return;
            }
            await this.leaseRepo.markInvalidated(prKey);
            this.logger.log({
                message: `SandboxLeaseManager: marked INVALIDATED (mid-create) prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey },
            });
            return;
        }

        // READY or PAUSED: soft-drain then delete
        // Local sandbox path
        if (isLocalSandboxPath(doc.sandboxId)) {
            if (doc.leaseCount <= 0) {
                const claimed = await this.leaseRepo.claimCleanup(
                    prKey,
                    doc.sandboxId,
                    true,
                );
                if (claimed) {
                    try {
                        await deleteLocalSandbox(doc.sandboxId);
                        await this.leaseRepo.completeCleanup(
                            prKey,
                            doc.sandboxId,
                        );
                    } catch (err) {
                        await this.leaseRepo.failCleanup(
                            prKey,
                            doc.sandboxId,
                            (err as Error).message,
                        );
                    }
                } else {
                    const latest = await this.leaseRepo.findByPrKey(prKey);
                    if (
                        latest?.sandboxId === doc.sandboxId &&
                        latest.state === 'READY'
                    ) {
                        await this.leaseRepo.markInvalidated(prKey);
                        this.logger.log({
                            message: `SandboxLeaseManager: invalidated READY local lease after losing cleanup claim prKey="${prKey}"`,
                            context: SandboxLeaseManager.name,
                            metadata: { prKey, sandboxId: doc.sandboxId },
                        });
                    }
                }
            } else {
                await this.leaseRepo.markInvalidated(prKey);
                this.logger.log({
                    message: `SandboxLeaseManager: invalidated active local lease (leaseCount>0) prKey="${prKey}"`,
                    context: SandboxLeaseManager.name,
                    metadata: {
                        prKey,
                        sandboxId: doc.sandboxId,
                        leaseCount: doc.leaseCount,
                    },
                });
            }
            return;
        }

        // E2B path: soft-drain then delete
        if (doc.sandboxId) {
            const apiKey = this.configService.get<string>('API_E2B_KEY');
            if (apiKey) {
                try {
                    // Give in-flight tool calls 60 seconds to finish before the sandbox dies
                    await Sandbox.setTimeout(
                        doc.sandboxId,
                        INVALIDATE_DRAIN_MS,
                        {
                            apiKey,
                        },
                    );
                    this.logger.log({
                        message: `SandboxLeaseManager: soft-drain 60s applied sandboxId="${doc.sandboxId}" prKey="${prKey}"`,
                        context: SandboxLeaseManager.name,
                        metadata: { prKey, sandboxId: doc.sandboxId },
                    });
                } catch (err) {
                    this.logger.warn({
                        message: `SandboxLeaseManager: soft-drain setTimeout failed sandboxId="${doc.sandboxId}"`,
                        context: SandboxLeaseManager.name,
                        error: err,
                    });
                }
            }
        }

        // The 60s timeout above only PAUSES the sandbox (onTimeout: 'pause').
        // Retire instead of delete so the idle-kill cron still kills it.
        if (doc.sandboxId) {
            // A consumer still mid-review keeps the sandbox until the lease
            // TTL, the same ceiling the reaper enforces on any lease.
            await this.leaseRepo.retire(prKey, doc.sandboxId, {
                idleKillAt: new Date(Date.now() + INVALIDATE_DRAIN_MS),
                busyKillAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS),
            });
        } else {
            await this.leaseRepo.delete(prKey);
        }
        this.logger.log({
            message: `SandboxLeaseManager: lease retired after invalidation prKey="${prKey}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey },
        });
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Kill a sandbox we are about to drop the lease for. If the kill fails,
     * retire the lease so the idle-kill cron retries it — otherwise the
     * paused sandbox has no lease left and nothing will ever kill it.
     */
    private async killOrRetire(
        prKey: string,
        sandboxId: string,
        apiKey: string,
    ): Promise<void> {
        try {
            await Sandbox.kill(sandboxId, { apiKey });
        } catch (err) {
            this.logger.warn({
                message: `SandboxLeaseManager: kill failed, retiring lease for cron retry sandboxId="${sandboxId}" prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                error: err,
                metadata: { prKey, sandboxId },
            });
            await this.leaseRepo
                .retire(prKey, sandboxId, {
                    idleKillAt: new Date(),
                    busyKillAt: new Date(),
                })
                .catch(() => {});
        }
    }

    private async handleCreatorPath(
        prKey: string,
        leaseId: string,
        consumer: string,
        cloneParams?: CreateSandboxParams,
        signal?: AbortSignal,
    ): Promise<AcquireResult> {
        this.logger.log({
            message: `SandboxLeaseManager: creator path — creating sandbox prKey="${prKey}" consumer="${consumer}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer },
        });

        // Hoisted out of the try so the catch can detect "sandbox was created
        // but a later step failed" and kill the orphan before re-throwing.
        let sandbox: SandboxInstance | undefined;
        let sandboxId: string | undefined;

        try {
            if (this.sandboxProvider.isAvailable() && cloneParams) {
                sandbox = await this.createWithRetry(
                    prKey,
                    cloneParams,
                    signal,
                );
            } else {
                // No provider configured or no clone params supplied — use null sandbox
                sandbox = this.buildNullSandboxWithRelease(prKey, leaseId);
            }

            sandboxId = sandbox.sandboxId;

            await this.leaseRepo.updateReady(
                prKey,
                sandboxId,
                sandbox?.baseBranch,
                sandbox?.privilegesDropped,
            );

            // Check for mid-create invalidation (Pitfall 5)
            const latestDoc = await this.leaseRepo.findByPrKey(prKey);
            if (latestDoc?.state === 'INVALIDATED') {
                this.logger.warn({
                    message: `SandboxLeaseManager: sandbox created but lease was INVALIDATED mid-create prKey="${prKey}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey, sandboxId },
                });
                // Kill the sandbox we just created; it is orphaned
                if (sandboxId) {
                    if (isLocalSandboxPath(sandboxId)) {
                        try {
                            await deleteLocalSandbox(sandboxId);
                        } catch (localErr) {
                            this.logger.warn({
                                message: `SandboxLeaseManager: Failed to clean local sandbox after mid-create invalidation prKey="${prKey}"`,
                                context: SandboxLeaseManager.name,
                                error: localErr as Error,
                            });
                            // Finding 4 fix: don't delete the lease doc when
                            // local cleanup fails — keep it so the reaper can
                            // retry the cleanup.
                            throw new SandboxInvalidatedError(prKey, true, {
                                cause: localErr,
                            });
                        }
                    } else {
                        const apiKey =
                            this.configService.get<string>('API_E2B_KEY');
                        if (apiKey) {
                            await this.killOrRetire(prKey, sandboxId, apiKey);
                        }
                    }
                }
                await this.leaseRepo.delete(prKey);
                throw new SandboxInvalidatedError(prKey, true);
            }

            this.leaseIdToPrKey.set(leaseId, prKey);

            // Wrap cleanup so callers use leaseManager.release() not sandbox.kill()
            sandbox = {
                ...sandbox,
                cleanup: async () => {
                    await this.release(leaseId);
                },
            };

            this.logger.log({
                message: `SandboxLeaseManager: sandbox READY prKey="${prKey}" consumer="${consumer}" leaseId="${leaseId}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, consumer, leaseId, sandboxId },
            });

            return { sandbox, leaseId, sandboxId, wasCreated: true };
        } catch (err) {
            // Local sandbox cleanup on creator failure
            if (sandboxId && isLocalSandboxPath(sandboxId)) {
                try {
                    await deleteLocalSandbox(sandboxId);
                } catch (cleanupErr) {
                    // Claim cleanup first, then mark as failed
                    const claimed = await this.leaseRepo.claimCleanup(
                        prKey,
                        sandboxId,
                    );
                    if (claimed) {
                        await this.leaseRepo.failCleanup(
                            prKey,
                            sandboxId,
                            (cleanupErr as Error).message,
                        );
                    } else {
                        this.logger.warn({
                            message: `SandboxLeaseManager: local cleanup failed but sandboxId not on doc — directory may be orphaned prKey="${prKey}" sandboxId="${sandboxId}"`,
                            context: SandboxLeaseManager.name,
                            error: cleanupErr as Error,
                        });
                    }
                    throw err;
                }
            }
            // If a real E2B sandbox was created but a later step failed
            // (Mongo update, mid-create invalidation, etc.), kill it so it
            // doesn't run for the full ceiling burning quota. Null-sandbox
            // doesn't need killing — its sandboxId is empty.
            else if (sandboxId) {
                const apiKey = this.configService.get<string>('API_E2B_KEY');
                if (apiKey) {
                    this.logger.warn({
                        message: `SandboxLeaseManager: killing orphaned sandbox after creator-path failure prKey="${prKey}" sandboxId="${sandboxId}"`,
                        context: SandboxLeaseManager.name,
                        metadata: { prKey, sandboxId },
                    });
                    await this.killOrRetire(prKey, sandboxId, apiKey);
                }
            }
            // Remove lease doc only if local cleanup succeeded or E2B/null path
            await this.leaseRepo.delete(prKey).catch(() => {});
            throw err;
        }
    }

    /**
     * Create a sandbox through the circuit breaker, with one retry for
     * transient failures (see CREATE_MAX_ATTEMPTS). Only the provider call is
     * wrapped — Mongo lease ops are atomic and a retry there would hide real
     * bugs (e.g. schema drift, validation).
     *
     * E2B refusing for lack of room in the plan (its concurrent-sandbox
     * limit) is not a failure: the create waits with backoff and tries again
     * until there is room, without spending an attempt or counting toward the
     * breaker. Only `signal` (the job's) ends that wait.
     */
    private async createWithRetry(
        prKey: string,
        cloneParams: CreateSandboxParams,
        signal?: AbortSignal,
    ): Promise<SandboxInstance> {
        // The breaker counts organizations: one tenant's failures (its git host
        // down, its huge repos) must not open it for every other tenant.
        const orgKey = prKey.split(':')[0];
        const startedAt = Date.now();
        let capacityWaits = 0;
        let lastErr: unknown;

        for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS;) {
            const permit = this.createCircuit.tryAcquire();
            if (
                !permit &&
                capacityWaits > 0 &&
                this.createCircuit.getState() === 'HALF_OPEN'
            ) {
                // Waiting for E2B room, this create gave its probe up and
                // another took it. That is not an outage verdict: keep
                // waiting until the probe decides (CLOSED lets this create
                // through, OPEN ends it below).
                const delayMs = calculateBackoffInterval(
                    capacityWaits++,
                    CAPACITY_WAIT_BACKOFF,
                );
                if ((await waitFor(null, delayMs, signal)) === 'aborted') {
                    throw new SandboxWaitAbortedError(
                        prKey,
                        Date.now() - startedAt,
                        'room in the E2B plan',
                    );
                }
                continue;
            }
            if (!permit) {
                const retryInMs = this.createCircuit.remainingOpenMs();
                this.logger.warn({
                    message: `SandboxLeaseManager: sandbox creation circuit open, skipping create prKey="${prKey}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey, retryInMs, attempt: attempt + 1 },
                });
                throw new SandboxCircuitOpenError(prKey, retryInMs);
            }

            try {
                const sandbox =
                    await this.sandboxProvider.createSandboxWithRepo(
                        cloneParams,
                    );
                this.createCircuit.recordSuccess(permit);
                return sandbox;
            } catch (err) {
                lastErr = err;

                if (isSandboxCapacityFailure(err)) {
                    this.createCircuit.releaseProbe(permit);
                    const delayMs = calculateBackoffInterval(
                        capacityWaits++,
                        CAPACITY_WAIT_BACKOFF,
                    );
                    this.logger.warn({
                        message: `SandboxLeaseManager: E2B plan has no room for another sandbox; retrying in ${delayMs}ms prKey="${prKey}"`,
                        context: SandboxLeaseManager.name,
                        error: err,
                        metadata: {
                            prKey,
                            delayMs,
                            capacityWaits,
                            waitedMs: Date.now() - startedAt,
                        },
                    });
                    if ((await waitFor(null, delayMs, signal)) === 'aborted') {
                        throw new SandboxWaitAbortedError(
                            prKey,
                            Date.now() - startedAt,
                            'room in the E2B plan',
                        );
                    }
                    continue;
                }

                const repositorySpecific =
                    isRepositorySpecificSandboxFailure(err);
                if (repositorySpecific) {
                    this.createCircuit.releaseProbe(permit);
                } else {
                    this.createCircuit.recordFailure(orgKey, permit);
                }

                attempt++;
                const retryable =
                    !repositorySpecific && !isTimeoutSandboxFailure(err);
                if (!retryable || attempt >= CREATE_MAX_ATTEMPTS) break;

                this.logger.warn({
                    message: `SandboxLeaseManager: provider.createSandboxWithRepo failed (attempt ${attempt}/${CREATE_MAX_ATTEMPTS}); retrying in ${CREATE_RETRY_DELAY_MS}ms`,
                    context: SandboxLeaseManager.name,
                    error: err,
                    metadata: { prKey },
                });
                await sleep(CREATE_RETRY_DELAY_MS);
            }
        }

        throw lastErr;
    }

    /**
     * One line per breaker state change. OPEN is a warn: from then on this
     * worker reviews without a sandbox until a probe succeeds. Search the
     * logs for "sandbox creation circuit" to see how often it trips.
     */
    private logCircuitTransition(transition: SandboxCircuitTransition): void {
        const payload = {
            message: `SandboxLeaseManager: sandbox creation circuit ${transition.from} -> ${transition.to}`,
            context: SandboxLeaseManager.name,
            metadata: { ...transition },
        };
        if (transition.to === 'OPEN') {
            this.logger.warn(payload);
        } else {
            this.logger.log(payload);
        }
    }

    private async handleJoinerPath(
        prKey: string,
        leaseId: string,
        consumer: string,
        state: string,
        sandboxId?: string,
        cloneParams?: CreateSandboxParams,
    ): Promise<AcquireResult> {
        if (state === 'INVALIDATED') {
            // Finding 2 fix: do NOT delete the sandbox here — active leases
            // may still be using it. The reaper will clean up when all leases
            // release and the TTL expires.
            throw new SandboxInvalidatedError(prKey);
        }

        if (state === 'READY' && sandboxId) {
            return this.connectToExisting(
                prKey,
                leaseId,
                consumer,
                sandboxId,
                cloneParams,
            );
        }

        // state === 'CREATING' (or PAUSED without sandboxId): poll until READY
        this.logger.log({
            message: `SandboxLeaseManager: joiner path — polling for READY prKey="${prKey}" consumer="${consumer}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer },
        });

        const deadline = Date.now() + MAX_POLL_WAIT_MS;
        while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            const doc = await this.leaseRepo.findByPrKey(prKey);

            if (!doc) {
                throw new Error(
                    `SandboxLeaseManager: lease disappeared while polling for READY prKey="${prKey}"`,
                );
            }

            if (doc.state === 'INVALIDATED') {
                throw new SandboxInvalidatedError(prKey);
            }

            if (doc.state === 'READY' && doc.sandboxId) {
                return this.connectToExisting(
                    prKey,
                    leaseId,
                    consumer,
                    doc.sandboxId,
                    cloneParams,
                );
            }
        }

        throw new SandboxCreateTimeoutError(prKey);
    }

    private async connectToExisting(
        prKey: string,
        leaseId: string,
        consumer: string,
        sandboxId: string,
        cloneParams?: CreateSandboxParams,
    ): Promise<AcquireResult> {
        const apiKey = this.configService.get<string>('API_E2B_KEY');

        if (!apiKey) {
            // No E2B key — return null sandbox (callers in self-contained mode)
            const sandbox = this.buildNullSandboxWithRelease(prKey, leaseId);
            this.leaseIdToPrKey.set(leaseId, prKey);
            return { sandbox, leaseId, sandboxId, wasCreated: false };
        }

        this.logger.log({
            message: `SandboxLeaseManager: connecting to existing sandbox sandboxId="${sandboxId}" prKey="${prKey}" consumer="${consumer}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer, sandboxId },
        });

        let e2bSandbox: Sandbox;
        try {
            e2bSandbox = await Sandbox.connect(sandboxId, { apiKey });
        } catch (err) {
            // Sandbox no longer exists in E2B (idle-kill timer fired,
            // reaper killed it, or it hit ceiling). Clean up the stale
            // lease and treat the caller as the creator of a fresh
            // sandbox — preserving the "sempre tem sandbox válido"
            // contract for the consumer.
            this.logger.warn({
                message: `SandboxLeaseManager: stale sandbox connect failed for sandboxId="${sandboxId}" prKey="${prKey}" — deleting lease and cold-starting`,
                context: SandboxLeaseManager.name,
                error: err,
                metadata: { prKey, sandboxId },
            });
            // Drop the in-memory lease tracking before delete (release()
            // would no-op without it; we want a clean slate)
            this.leaseIdToPrKey.delete(leaseId);
            // Retire, not delete: connect can fail transiently while the
            // sandbox still exists (paused), and a dropped lease is the
            // last trace the kill crons had of it. A co-tenant still using
            // it (leaseCount beyond our own hold) keeps it until the lease
            // TTL, when the reaper would have killed it anyway. If it really
            // is gone, the kill 404s and the retired doc is removed.
            await this.leaseRepo
                .retire(prKey, sandboxId, {
                    idleKillAt: new Date(Date.now() + INVALIDATE_DRAIN_MS),
                    busyKillAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS),
                    ownHolds: 1,
                })
                .catch(() => {});
            // Re-acquire from scratch. With doc deleted, upsertAcquire
            // will hit creator path and cold-create. cloneParams must be
            // passed by the original caller for cold-create to clone repo;
            // the joiner here doesn't have them, so we throw a typed
            // error and let the caller retry with full params.
            throw new SandboxStaleConnectionError(prKey, sandboxId);
        }

        // Bring a reused sandbox's git checkout up to date with the CURRENT
        // commit before handing it back — see syncE2BSandboxRepo's docstring
        // for the stale-checkout bug this closes (#1313 e2e validation,
        // 2026-09-11). Best-effort: a sync failure falls back to whatever
        // was already on disk (the pre-fix behavior), it never fails the
        // acquire.
        //
        // Skip the sync entirely when another consumer currently holds this
        // lease (leaseCount > 1, e.g. round N's AgentReviewStage still
        // reading files while round N+1 joins after a fast follow-up push):
        // `checkout -f` + `clean -fd` rewrite the sandbox's ONE shared
        // working tree, so running it here would yank the tree out from
        // under that other consumer's in-flight readFile/grep calls — the
        // exact identical-context/working-tree contradiction this sync was
        // added to fix, just caused by the fix itself. Re-reading the doc
        // right before the destructive commands narrows the race to the gap
        // between this read and the checkout, instead of leaving it open for
        // the other consumer's entire pipeline run.
        if (cloneParams) {
            // Best-effort re-read: a transient failure here must fall back to
            // running the sync (the pre-fix behavior), not fail the acquire.
            const currentDoc = await this.leaseRepo
                .findByPrKey(prKey)
                .catch(() => null);
            if (currentDoc && currentDoc.leaseCount > 1) {
                this.logger.log({
                    message: `SandboxLeaseManager: skipping destructive git sync for sandboxId="${sandboxId}" prKey="${prKey}" — leaseCount=${currentDoc.leaseCount} other consumer(s) active`,
                    context: SandboxLeaseManager.name,
                    metadata: {
                        organizationId: prKey.split(':')[0],
                        prKey,
                        sandboxId,
                        leaseCount: currentDoc.leaseCount,
                    },
                });
            } else {
                try {
                    await syncE2BSandboxRepo(e2bSandbox, cloneParams, {
                        logger: this.logger,
                        logContext: SandboxLeaseManager.name,
                    });
                } catch (err) {
                    this.logger.warn({
                        message: `SandboxLeaseManager: syncE2BSandboxRepo threw for sandboxId="${sandboxId}" prKey="${prKey}" — sandbox keeps its previous checkout`,
                        context: SandboxLeaseManager.name,
                        error: err,
                        metadata: { prKey, sandboxId },
                    });
                }
            }
        }

        // The caller's value is authoritative for THIS review; the persisted
        // one covers a joiner that arrived without clone params.
        const leaseDoc = await this.leaseRepo
            .findByPrKey(prKey)
            .catch(() => null);
        const baseBranch = cloneParams?.baseBranch ?? leaseDoc?.baseBranch;

        const sandbox: SandboxInstance = this.buildSandboxInstance(
            e2bSandbox,
            prKey,
            leaseId,
            baseBranch,
            // Only what creation recorded counts: dropping now would not undo
            // what earlier rounds could do while the user still had sudo.
            leaseDoc?.privilegesDropped === true,
        );
        this.leaseIdToPrKey.set(leaseId, prKey);

        this.logger.log({
            message: `SandboxLeaseManager: connected to existing sandbox prKey="${prKey}" consumer="${consumer}" leaseId="${leaseId}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer, leaseId, sandboxId },
        });

        return { sandbox, leaseId, sandboxId, wasCreated: false };
    }

    /**
     * Build a minimal SandboxInstance wrapping an existing connected E2B sandbox.
     * This is used by the joiner path when connecting to an already-READY sandbox.
     */
    private buildSandboxInstance(
        e2bSandbox: Sandbox,
        prKey: string,
        leaseId: string,
        baseBranch?: string,
        privilegesDropped = false,
    ): SandboxInstance {
        return {
            // Restored from the lease. The base ref is already on disk from
            // creation, but without the NAME nothing can ask git for it, and a
            // tool that needs the previous version of a file then silently has
            // no baseline — the same creator/reconnect drift the shared
            // remoteCommands above exists to prevent.
            // Normalized here rather than at each call site: creator and
            // joiner reach this from different places, and a joiner that
            // re-introduced the host's raw `refs/heads/...` spelling would
            // break `origin/<base>` for every consumer.
            baseBranch: toBranchName(baseBranch),
            // Single shared implementation (see e2b-sandbox.service.ts) — resolves
            // paths against the repo root, surfaces errors, logs empty reads.
            // Sharing it prevents the creator/reconnect drift that blinded reviews.
            remoteCommands: buildE2BRemoteCommands(e2bSandbox, {
                logger: this.logger,
                logContext: SandboxLeaseManager.name,
                logMetadata: {
                    organizationId: prKey.split(':')[0],
                    prKey,
                },
            }),
            cleanup: async () => {
                await this.release(leaseId);
            },
            type: 'e2b',
            sandboxId: e2bSandbox.sandboxId,
            repoDir: '/home/user/repo',
            privilegesDropped,
            run: (command: string, opts?: SandboxRunOptions) =>
                runE2BCommand(e2bSandbox, command, opts),
            readFile: async (path: string, opts?: { timeoutMs?: number }) => {
                return e2bSandbox.files.read(path, {
                    requestTimeoutMs: opts?.timeoutMs ?? 600_000,
                });
            },
            writeFile: async (path: string, content: string) => {
                await e2bSandbox.files.write(path, content);
            },
        };
    }

    /**
     * Build a null sandbox with a release-bound cleanup function.
     * Used when E2B is not configured or when connect is not needed.
     */
    private buildNullSandboxWithRelease(
        prKey: string,
        leaseId: string,
    ): SandboxInstance {
        return {
            ...NULL_SANDBOX_INSTANCE,
            cleanup: async () => {
                await this.release(leaseId);
            },
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One worker slot, shared by every lease this process holds on a prKey. */
interface WorkerSlot {
    slotId: string;
    refs: number;
    granted: Promise<boolean>;
}

type CapacityWaitOutcome = 'granted' | 'withdrawn' | 'tick' | 'aborted';

/**
 * Waits for whichever comes first: `granted` settling (when given), `ms`
 * elapsing, or `signal` aborting.
 */
function waitFor(
    granted: Promise<boolean> | null,
    ms: number,
    signal?: AbortSignal,
): Promise<CapacityWaitOutcome> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve('aborted');
            return;
        }
        const onAbort = () => done('aborted');
        const timer = setTimeout(() => done('tick'), ms);
        signal?.addEventListener('abort', onAbort, { once: true });
        granted?.then((ok) => done(ok ? 'granted' : 'withdrawn'));

        function done(outcome: CapacityWaitOutcome) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(outcome);
        }
    });
}
