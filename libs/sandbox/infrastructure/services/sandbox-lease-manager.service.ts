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
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';
import { randomUUID } from 'crypto';

import { calculateBackoffInterval } from '@libs/common/utils/polling';
import { SandboxLeaseRepository } from '../repositories/sandbox-lease.repository';
import { NULL_SANDBOX_INSTANCE } from '../providers/null-sandbox.service';

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
        private readonly leaseRepo: SandboxLeaseRepository,
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

        const doc = await this.leaseRepo.upsertAcquire(prKey, leaseTtlMs, consumer);
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
            return this.handleCreatorPath(prKey, leaseId, consumer, cloneParams);
        }

        // --- Path B: joiner — doc already existed or someone else is creating ---
        try {
            return await this.handleJoinerPath(prKey, leaseId, consumer, doc.state, doc.sandboxId);
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
                return this.acquire(prKey, consumer, leaseTtlMs, cloneParams);
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
    async release(
        leaseId: string,
        opts?: { idleMs?: number },
    ): Promise<void> {
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
            const idleMs = opts?.idleMs ?? IDLE_TIMEOUT_MS;
            const killAt = new Date(Date.now() + idleMs);
            await this.leaseRepo.setKillAt(prKey, killAt);

            this.logger.log({
                message: `SandboxLeaseManager: scheduled idle-kill at ${killAt.toISOString()} for sandboxId="${updated.sandboxId}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey, sandboxId: updated.sandboxId, idleTimeoutMs: idleMs, killAt },
            });

            const apiKey = this.configService.get<string>('API_E2B_KEY');
            if (apiKey) {
                try {
                    await Sandbox.setTimeout(updated.sandboxId, idleMs, { apiKey });
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
            await this.leaseRepo.markInvalidated(prKey);
            this.logger.log({
                message: `SandboxLeaseManager: marked INVALIDATED (mid-create) prKey="${prKey}"`,
                context: SandboxLeaseManager.name,
                metadata: { prKey },
            });
            return;
        }

        // READY or PAUSED: soft-drain then delete
        if (doc.sandboxId) {
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
                    const apiKey = this.configService.get<string>('API_E2B_KEY');
                    if (apiKey) {
                        await Sandbox.kill(sandboxId, { apiKey }).catch(() => {});
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
            // If a real E2B sandbox was created but a later step failed
            // (Mongo update, mid-create invalidation, etc.), kill it so it
            // doesn't run for the full ceiling burning quota. Null-sandbox
            // doesn't need killing — its sandboxId is empty.
            if (sandboxId) {
                const apiKey = this.configService.get<string>('API_E2B_KEY');
                if (apiKey) {
                    this.logger.warn({
                        message: `SandboxLeaseManager: killing orphaned sandbox after creator-path failure prKey="${prKey}" sandboxId="${sandboxId}"`,
                        context: SandboxLeaseManager.name,
                        metadata: { prKey, sandboxId },
                    });
                    await Sandbox.kill(sandboxId, { apiKey }).catch(() => {});
                }
            }
            // Remove the lease doc so other callers don't poll forever
            await this.leaseRepo.delete(prKey).catch(() => {});
            throw err;
        }
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

        if (state === 'READY' && sandboxId) {
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

            if (doc.state === 'READY' && doc.sandboxId) {
                return this.connectToExisting(prKey, leaseId, consumer, doc.sandboxId);
            }
        }

        throw new SandboxCreateTimeoutError(prKey);
    }

    private async connectToExisting(
        prKey: string,
        leaseId: string,
        consumer: string,
        sandboxId: string,
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
            await this.leaseRepo.delete(prKey).catch(() => {});
            // Re-acquire from scratch. With doc deleted, upsertAcquire
            // will hit creator path and cold-create. cloneParams must be
            // passed by the original caller for cold-create to clone repo;
            // the joiner here doesn't have them, so we throw a typed
            // error and let the caller retry with full params.
            throw new SandboxStaleConnectionError(prKey, sandboxId);
        }

        const sandbox: SandboxInstance = this.buildSandboxInstance(e2bSandbox, prKey, leaseId);
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
    private buildSandboxInstance(e2bSandbox: Sandbox, prKey: string, leaseId: string): SandboxInstance {
        return {
            remoteCommands: {
                grep: async (pattern: string, path: string, glob?: string) => {
                    const globArg = glob ? `--glob '${glob}'` : '';
                    const result = await e2bSandbox.commands.run(
                        `rg --no-heading -n ${globArg} -e '${pattern}' '${path}' 2>/dev/null || true`,
                        { timeoutMs: 30_000 },
                    );
                    return result.stdout || '';
                },
                read: async (path: string, start: number, end: number) => {
                    const result = await e2bSandbox.commands.run(
                        `sed -n '${start},${end}p' '${path}' 2>/dev/null || true`,
                        { timeoutMs: 10_000 },
                    );
                    return result.stdout || '';
                },
                listDir: async (path: string, maxDepth: number) => {
                    const result = await e2bSandbox.commands.run(
                        `find '${path}' -maxdepth ${maxDepth} 2>/dev/null | head -200 || true`,
                        { timeoutMs: 10_000 },
                    );
                    return result.stdout || '';
                },
                exec: async (command: string) => {
                    const result = await e2bSandbox.commands.run(command, { timeoutMs: 30_000 });
                    return { stdout: result.stdout || '', exitCode: result.exitCode };
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
    private buildNullSandboxWithRelease(prKey: string, leaseId: string): SandboxInstance {
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
