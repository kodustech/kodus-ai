import { createLogger } from '@kodus/flow';
import {
    AcquireResult,
    assertValidPrKey,
    ISandboxLeaseManager,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    ISandboxLeaseRepository,
    SandboxLeaseRecord,
    SANDBOX_LEASE_REPOSITORY_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox-lease.repository.contract';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';
import { randomUUID } from 'crypto';

import { calculateBackoffInterval } from '@libs/common/utils/polling';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { NULL_SANDBOX_INSTANCE } from '../providers/null-sandbox.service';
import {
    cleanupLocalSandboxDirectory,
    isLocalSandboxPath,
} from './local-sandbox-cleanup';

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
 * How often to poll when waiting for a concurrent creator to finish.
 */
const POLL_INTERVAL_MS = 500;

/**
 * Maximum time to wait for a CREATING sandbox to become READY.
 * Exceeding this throws SandboxCreateTimeoutError.
 */
const MAX_POLL_WAIT_MS = 30_000; // 30 seconds

/**
 * Sandbox creation retry budget. Three attempts total (initial + 2 retries).
 * Backoff intervals are computed by the project's exponential-backoff lib
 * (`@libs/common/utils/polling`) so this stays consistent with how other
 * services pace retries. Configured to land at exactly 60s → 120s with no
 * jitter (deterministic, easy to reason about under quota outages).
 *
 * The provider call is the only thing wrapped — other lease operations
 * (Mongo upsert/update) are atomic and fast, so a retry there would mask
 * real errors instead of fixing them.
 *
 * Total worst-case overhead from backoffs alone: 60 + 120 = 180s.
 */
const CREATE_MAX_ATTEMPTS = 3;
const CREATE_BACKOFF_OPTIONS = {
    baseInterval: 60_000, // 1 min
    maxInterval: 120_000, // 2 min cap (so attempt-1 → 120s, not 240s)
    multiplier: 2,
    jitterFactor: 0,
} as const;

const MAX_STALE_SANDBOX_REACQUIRE_ATTEMPTS = 3;

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
 * Thrown internally when reconnecting to a persisted sandbox fails because
 * the provider can no longer attach to it (idle-kill, reaper, worker-local
 * temp cleanup, or external termination). The acquire() loop catches this,
 * retries from scratch, and only surfaces it if the cold-start retry also
 * fails.
 */
export class SandboxStaleConnectionError extends Error {
    constructor(prKey: string, sandboxId: string) {
        super(
            `SandboxLeaseManager: stale sandbox connection — sandboxId="${sandboxId}" can no longer be reconnected for prKey="${prKey}"; lease cleaned, retry expected`,
        );
        this.name = 'SandboxStaleConnectionError';
    }
}

@Injectable()
export class SandboxLeaseManager implements ISandboxLeaseManager {
    private readonly logger = createLogger(SandboxLeaseManager.name);

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

    constructor(
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        @Inject(SANDBOX_LEASE_REPOSITORY_TOKEN)
        private readonly leaseRepo: ISandboxLeaseRepository,
        private readonly configService: ConfigService,
    ) {}

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
    async acquire(
        prKey: string,
        consumer: string,
        leaseTtlMs = DEFAULT_LEASE_TTL_MS,
        cloneParams?: CreateSandboxParams,
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
        const leaseId = randomUUID();

        // A new acquire arrived — atomically clear any pending idle-kill so
        // the warm sandbox isn't killed under us between this call and
        // connect(). Multi-worker safe: any worker that reads the doc next
        // will see killAt=null and skip.
        await this.leaseRepo.clearKillAt(prKey);

        return this.resolveAcquiredLease(
            prKey,
            leaseId,
            consumer,
            leaseTtlMs,
            cloneParams,
            doc,
        );
    }

    /**
     * Release a lease. Decrements leaseCount atomically.
     *
     * When leaseCount reaches 0, local sandboxes are deleted immediately
     * because their working tree lives in the worker's OS temp directory.
     * E2B sandboxes keep the warm-reuse behavior: write
     * `killAt = now + idleMs` on the lease doc (via leaseRepo.setKillAt).
     * The `killIdleSandboxes` cron (any worker, coordinated via Postgres
     * advisory lock) picks up the doc once the timestamp elapses and
     * issues Sandbox.kill + delete. This makes E2B idle-kill multi-worker
     * safe without in-memory state.
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
            if (isLocalSandboxPath(updated.sandboxId)) {
                const marked =
                    await this.leaseRepo.markDeletingIfNoActiveLeases(prKey);
                if (!marked) {
                    this.logger.log({
                        message: `SandboxLeaseManager: skipped local sandbox cleanup because lease was re-acquired prKey="${prKey}"`,
                        context: SandboxLeaseManager.name,
                        metadata: { prKey, sandboxId: updated.sandboxId },
                    });
                    return;
                }

                const cleaned = await this.cleanupLocalSandbox(
                    updated.sandboxId,
                    prKey,
                    'release',
                );
                if (cleaned) {
                    await this.deleteLocalLeaseIfStillInactive(
                        prKey,
                        updated.sandboxId,
                        'release',
                    );
                }
                return;
            }

            const idleMs = opts?.idleMs ?? IDLE_TIMEOUT_MS;
            const killAt = new Date(Date.now() + idleMs);
            const scheduled = await this.leaseRepo.setKillAt(prKey, killAt);
            if (!scheduled) {
                this.logger.log({
                    message: `SandboxLeaseManager: skipped idle-kill scheduling because lease was re-acquired prKey="${prKey}"`,
                    context: SandboxLeaseManager.name,
                    metadata: { prKey, sandboxId: updated.sandboxId },
                });
                return;
            }

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
     * - local READY/PAUSED: mark DELETING only if no active leases, remove the
     *   worker-local directory, then conditionally delete the doc.
     * - remote READY/PAUSED: soft-drain (60s setTimeout) then delete doc.
     * - doc not found: no-op (idempotent).
     */
    async invalidate(prKey: string): Promise<void> {
        this.logger.log({
            message: `SandboxLeaseManager: invalidate prKey="${prKey}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey },
        });

        // Clear any pending idle-kill so the cron doesn't double-clean —
        // invalidate owns cleanup for both local and remote sandboxes.
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
            await this.leaseRepo.markInvalidated(prKey);
            this.logger.log({
                message: `SandboxLeaseManager: marked INVALIDATED (mid-create) prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey },
            });
            return;
        }

        // READY or PAUSED: local cleanup is immediate; remote cleanup uses
        // a short E2B soft-drain before deleting the lease document.
        if (doc.sandboxId) {
            if (isLocalSandboxPath(doc.sandboxId)) {
                const marked =
                    await this.leaseRepo.markDeletingIfNoActiveLeases(prKey);
                if (!marked) {
                    this.logger.log({
                        message: `SandboxLeaseManager: skipped local sandbox invalidation cleanup because lease was re-acquired prKey="${prKey}"`,
                        context: SandboxLeaseManager.name,
                        metadata: { prKey, sandboxId: doc.sandboxId },
                    });
                    return;
                }

                const cleaned = await this.cleanupLocalSandbox(
                    doc.sandboxId,
                    prKey,
                    'invalidate',
                );
                if (cleaned) {
                    await this.deleteLocalLeaseIfStillInactive(
                        prKey,
                        doc.sandboxId,
                        'invalidation',
                    );
                }
                return;
            }

            const apiKey = this.configService.get<string>('API_E2B_KEY');
            if (apiKey) {
                try {
                    // Give in-flight tool calls 60 seconds to finish before the sandbox dies
                    await Sandbox.setTimeout(doc.sandboxId, 60_000, { apiKey });
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

        await this.leaseRepo.delete(prKey);
        this.logger.log({
            message: `SandboxLeaseManager: lease deleted after invalidation prKey="${prKey}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey },
        });
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private async resolveAcquiredLease(
        prKey: string,
        leaseId: string,
        consumer: string,
        leaseTtlMs: number,
        cloneParams: CreateSandboxParams | undefined,
        initialDoc: SandboxLeaseRecord,
    ): Promise<AcquireResult> {
        let doc = initialDoc;

        for (
            let staleAttempt = 0;
            staleAttempt <= MAX_STALE_SANDBOX_REACQUIRE_ATTEMPTS;
            staleAttempt++
        ) {
            try {
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
                    );
                }

                // --- Path B: joiner — doc already existed or someone else is creating ---
                return await this.handleJoinerPath(
                    prKey,
                    leaseId,
                    consumer,
                    doc.state,
                    doc.sandboxId,
                );
            } catch (err) {
                if (
                    !(err instanceof SandboxStaleConnectionError) ||
                    staleAttempt === MAX_STALE_SANDBOX_REACQUIRE_ATTEMPTS
                ) {
                    throw err;
                }

                // Lease referenced a sandbox the provider can no longer
                // reconnect to, or a DELETING lease finished cleanup while this
                // acquire was waiting. Recreate explicitly and keep the same
                // leaseId through the retry so cleanup() releases the sandbox
                // that this acquire eventually returns.
                this.logger.log({
                    message: `SandboxLeaseManager: re-acquiring after stale sandbox prKey="${prKey}" consumer="${consumer}" attempt=${staleAttempt + 1}`,
                    context: SandboxLeaseManager.name,
                    metadata: {
                        prKey,
                        consumer,
                        staleAttempt: staleAttempt + 1,
                    },
                });
                doc = await this.leaseRepo.upsertAcquire(
                    prKey,
                    leaseTtlMs,
                    consumer,
                );
                await this.leaseRepo.clearKillAt(prKey);
            }
        }

        throw new SandboxCreateTimeoutError(prKey);
    }

    private async handleCreatorPath(
        prKey: string,
        leaseId: string,
        consumer: string,
        cloneParams?: CreateSandboxParams,
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
                sandbox = await this.createWithRetry(cloneParams);
            } else {
                // No provider configured or no clone params supplied — use null sandbox
                sandbox = this.buildNullSandboxWithRelease(prKey, leaseId);
            }

            sandboxId = sandbox.sandboxId;

            await this.leaseRepo.updateReady(prKey, sandboxId);

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
                        await this.cleanupLocalSandbox(
                            sandboxId,
                            prKey,
                            'mid-create invalidation',
                        );
                    } else {
                        const apiKey =
                            this.configService.get<string>('API_E2B_KEY');
                        if (apiKey) {
                            await Sandbox.kill(sandboxId, { apiKey }).catch(
                                () => {},
                            );
                        }
                    }
                }
                // Clean up the invalidated doc
                await this.leaseRepo.delete(prKey);
                throw new Error(
                    `SandboxLeaseManager: sandbox invalidated mid-create for prKey="${prKey}"`,
                );
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
            // If a real sandbox was created but a later step failed (Mongo
            // update, mid-create invalidation, etc.), clean it up so it
            // doesn't run for the full ceiling / leak host disk. Null-sandbox
            // doesn't need cleanup — its sandboxId is empty.
            if (sandboxId) {
                if (isLocalSandboxPath(sandboxId)) {
                    await this.cleanupLocalSandbox(
                        sandboxId,
                        prKey,
                        'creator-path failure',
                    );
                } else {
                    const apiKey =
                        this.configService.get<string>('API_E2B_KEY');
                    if (apiKey) {
                        this.logger.warn({
                            message: `SandboxLeaseManager: killing orphaned sandbox after creator-path failure prKey="${prKey}" sandboxId="${sandboxId}"`,
                            context: SandboxLeaseManager.name,
                            metadata: { prKey, sandboxId },
                        });
                        await Sandbox.kill(sandboxId, { apiKey }).catch(
                            () => {},
                        );
                    }
                }
            }
            // Remove the lease doc so other callers don't poll forever
            await this.leaseRepo.delete(prKey).catch(() => {});
            throw err;
        }
    }

    private async cleanupLocalSandbox(
        sandboxId: string,
        prKey: string,
        reason: string,
    ): Promise<boolean> {
        if (!isLocalSandboxPath(sandboxId)) {
            return false;
        }

        try {
            const cleaned = await cleanupLocalSandboxDirectory(sandboxId);
            this.logger.log({
                message: `SandboxLeaseManager: removed local sandbox directory after ${reason}`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, sandboxId, reason },
            });
            return cleaned;
        } catch (error) {
            this.logger.warn({
                message: `SandboxLeaseManager: failed to remove local sandbox directory after ${reason}`,
                context: SandboxLeaseManager.name,
                error,
                metadata: { prKey, sandboxId, reason },
            });
            return false;
        }
    }

    private async deleteLocalLeaseIfStillInactive(
        prKey: string,
        sandboxId: string,
        reason: string,
    ): Promise<boolean> {
        const deleted = await this.leaseRepo.deleteIfNoActiveLeases(prKey);
        if (!deleted) {
            this.logger.log({
                message: `SandboxLeaseManager: skipped local sandbox lease delete after ${reason} because lease was re-acquired prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, sandboxId },
            });
            return false;
        }

        this.logger.log({
            message: `SandboxLeaseManager: local sandbox lease deleted after ${reason} prKey="${prKey}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, sandboxId },
        });
        return true;
    }

    /**
     * Create a sandbox with retry + backoff. CREATE_MAX_ATTEMPTS attempts
     * total; intervals come from the shared polling lib so cadence matches
     * other services. Only the provider call is wrapped — Mongo lease ops
     * are atomic and a retry there would hide real bugs (e.g. schema drift,
     * validation).
     */
    private async createWithRetry(
        cloneParams: CreateSandboxParams,
    ): Promise<SandboxInstance> {
        let lastErr: unknown;

        for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS; attempt++) {
            try {
                return await this.sandboxProvider.createSandboxWithRepo(
                    cloneParams,
                );
            } catch (err) {
                lastErr = err;
                if (attempt === CREATE_MAX_ATTEMPTS - 1) break;

                const waitMs = calculateBackoffInterval(
                    attempt,
                    CREATE_BACKOFF_OPTIONS,
                );
                this.logger.warn({
                    message: `SandboxLeaseManager: provider.createSandboxWithRepo failed (attempt ${attempt + 1}/${CREATE_MAX_ATTEMPTS}); retrying in ${waitMs}ms`,
                    context: SandboxLeaseManager.name,
                    error: err,
                });
                await sleep(waitMs);
            }
        }

        throw lastErr;
    }

    private async handleJoinerPath(
        prKey: string,
        leaseId: string,
        consumer: string,
        state: string,
        sandboxId?: string,
    ): Promise<AcquireResult> {
        if (state === 'INVALIDATED') {
            throw new Error(
                `SandboxLeaseManager: sandbox invalidated for prKey="${prKey}"`,
            );
        }

        if (state === 'DELETING') {
            await this.waitForDeletingLeaseAndRollback(
                prKey,
                leaseId,
                sandboxId,
            );
            throw new SandboxStaleConnectionError(
                prKey,
                sandboxId ?? 'deleting',
            );
        }

        if (state === 'READY' && sandboxId !== undefined) {
            return this.connectToExisting(prKey, leaseId, consumer, sandboxId);
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
                throw new Error(
                    `SandboxLeaseManager: sandbox invalidated for prKey="${prKey}"`,
                );
            }

            if (doc.state === 'DELETING') {
                await this.waitForDeletingLeaseAndRollback(
                    prKey,
                    leaseId,
                    doc.sandboxId,
                );
                throw new SandboxStaleConnectionError(
                    prKey,
                    doc.sandboxId ?? 'deleting',
                );
            }

            if (doc.state === 'READY' && doc.sandboxId !== undefined) {
                return this.connectToExisting(
                    prKey,
                    leaseId,
                    consumer,
                    doc.sandboxId,
                );
            }
        }

        throw new SandboxCreateTimeoutError(prKey);
    }

    private async waitForDeletingLeaseAndRollback(
        prKey: string,
        leaseId: string,
        sandboxId?: string,
    ): Promise<void> {
        this.leaseIdToPrKey.delete(leaseId);
        await this.leaseRepo.decrementLease(prKey).catch(() => null);

        const deadline = Date.now() + MAX_POLL_WAIT_MS;
        while (Date.now() < deadline) {
            const doc = await this.leaseRepo.findByPrKey(prKey);
            if (!doc || doc.state !== 'DELETING') {
                return;
            }

            await sleep(POLL_INTERVAL_MS);
        }

        throw new Error(
            `SandboxLeaseManager: timed out waiting for deleting sandbox cleanup prKey="${prKey}" sandboxId="${sandboxId ?? ''}"`,
        );
    }

    private async connectToExisting(
        prKey: string,
        leaseId: string,
        consumer: string,
        sandboxId: string,
    ): Promise<AcquireResult> {
        if (!sandboxId) {
            // Null sandbox marker — return a release-bound null sandbox for
            // self-contained callers and READY leases with empty sandboxId.
            const sandbox = this.buildNullSandboxWithRelease(prKey, leaseId);
            this.leaseIdToPrKey.set(leaseId, prKey);
            return { sandbox, leaseId, sandboxId, wasCreated: false };
        }

        if (isLocalSandboxPath(sandboxId)) {
            return this.connectToExistingLocalSandbox(
                prKey,
                leaseId,
                consumer,
                sandboxId,
            );
        }

        const apiKey = this.configService.get<string>('API_E2B_KEY');
        if (!apiKey) {
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
            await this.leaseRepo.delete(prKey).catch(() => {});
            // Re-acquire from scratch. With doc deleted, upsertAcquire
            // will hit creator path and cold-create. cloneParams must be
            // passed by the original caller for cold-create to clone repo;
            // the joiner here doesn't have them, so we throw a typed
            // error and let the caller retry with full params.
            throw new SandboxStaleConnectionError(prKey, sandboxId);
        }

        const sandbox: SandboxInstance = this.buildSandboxInstance(
            e2bSandbox,
            prKey,
            leaseId,
        );
        this.leaseIdToPrKey.set(leaseId, prKey);

        this.logger.log({
            message: `SandboxLeaseManager: connected to existing sandbox prKey="${prKey}" consumer="${consumer}" leaseId="${leaseId}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer, leaseId, sandboxId },
        });

        return { sandbox, leaseId, sandboxId, wasCreated: false };
    }

    private async connectToExistingLocalSandbox(
        prKey: string,
        leaseId: string,
        consumer: string,
        sandboxId: string,
    ): Promise<AcquireResult> {
        if (!this.sandboxProvider.connectToExistingSandbox) {
            this.logger.warn({
                message: `SandboxLeaseManager: local sandbox reconnect unsupported for sandboxId="${sandboxId}" prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, consumer, sandboxId },
            });
            this.leaseIdToPrKey.delete(leaseId);
            await this.rollbackLocalReconnectAcquire(prKey, sandboxId);
            throw new Error(
                `SandboxLeaseManager: local sandbox reconnect unsupported for prKey="${prKey}" sandboxId="${sandboxId}"`,
            );
        }

        this.logger.log({
            message: `SandboxLeaseManager: reconnecting to existing local sandbox sandboxId="${sandboxId}" prKey="${prKey}" consumer="${consumer}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer, sandboxId },
        });

        let providerSandbox: SandboxInstance;
        try {
            providerSandbox =
                await this.sandboxProvider.connectToExistingSandbox(sandboxId);
        } catch (err) {
            this.logger.warn({
                message: `SandboxLeaseManager: local sandbox reconnect failed for sandboxId="${sandboxId}" prKey="${prKey}" (expected in multi-node setups without shared /tmp)`,
                context: SandboxLeaseManager.name,
                error: err,
                metadata: { prKey, sandboxId },
            });
            this.leaseIdToPrKey.delete(leaseId);
            await this.rollbackLocalReconnectAcquire(prKey, sandboxId);
            throw err;
        }

        const sandbox: SandboxInstance = {
            ...providerSandbox,
            cleanup: async () => {
                await this.release(leaseId);
            },
        };
        this.leaseIdToPrKey.set(leaseId, prKey);

        this.logger.log({
            message: `SandboxLeaseManager: reconnected to existing local sandbox prKey="${prKey}" consumer="${consumer}" leaseId="${leaseId}"`,
            context: SandboxLeaseManager.name,
            metadata: { prKey, consumer, leaseId, sandboxId },
        });

        return { sandbox, leaseId, sandboxId, wasCreated: false };
    }

    private async rollbackLocalReconnectAcquire(
        prKey: string,
        sandboxId: string,
    ): Promise<void> {
        try {
            await this.leaseRepo.decrementLease(prKey);
        } catch (error) {
            this.logger.warn({
                message: `SandboxLeaseManager: failed to rollback local reconnect acquire for sandboxId="${sandboxId}" prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                error,
                metadata: { prKey, sandboxId },
            });
        }
    }

    /**
     * Build a minimal SandboxInstance wrapping an existing connected E2B sandbox.
     * This is used by the joiner path when connecting to an already-READY sandbox.
     */
    private buildSandboxInstance(
        e2bSandbox: Sandbox,
        prKey: string,
        leaseId: string,
    ): SandboxInstance {
        return {
            remoteCommands: {
                grep: async (pattern: string, path: string, glob?: string) => {
                    const globArg = glob ? `--glob ${shSingleQuote(glob)}` : '';
                    const result = await e2bSandbox.commands.run(
                        `rg --no-heading -n ${globArg} -e ${shSingleQuote(pattern)} ${shSingleQuote(path)} 2>/dev/null || true`,
                        { timeoutMs: 30_000 },
                    );
                    return result.stdout || '';
                },
                read: async (path: string, start: number, end: number) => {
                    const result = await e2bSandbox.commands.run(
                        `sed -n '${start},${end}p' ${shSingleQuote(path)} 2>/dev/null || true`,
                        { timeoutMs: 10_000 },
                    );
                    return result.stdout || '';
                },
                listDir: async (path: string, maxDepth: number) => {
                    const result = await e2bSandbox.commands.run(
                        `find ${shSingleQuote(path)} -maxdepth ${maxDepth} 2>/dev/null | head -200 || true`,
                        { timeoutMs: 10_000 },
                    );
                    return result.stdout || '';
                },
                exec: async (command: string) => {
                    const result = await e2bSandbox.commands.run(command, {
                        timeoutMs: 30_000,
                    });
                    return {
                        stdout: result.stdout || '',
                        exitCode: result.exitCode,
                    };
                },
            },
            cleanup: async () => {
                await this.release(leaseId);
            },
            type: 'e2b',
            sandboxId: e2bSandbox.sandboxId,
            repoDir: '/home/user/repo',
            run: async (command: string, opts?: { timeoutMs?: number }) => {
                const result = await e2bSandbox.commands.run(command, {
                    timeoutMs: opts?.timeoutMs ?? 30_000,
                });
                return {
                    stdout: result.stdout || '',
                    stderr: result.stderr || '',
                    exitCode: result.exitCode,
                };
            },
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
