import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@libs/core/log/logger';
import { Sandbox } from 'e2b';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import {
    isLocalSandboxPath,
    deleteLocalSandbox,
} from './local-sandbox-cleanup.service';

const CLEANUP_CONCURRENCY = 5;

// After this many failed Sandbox.kill attempts on a real failure (timeout,
// upstream error), escalate the log from warn to error ONCE — a sustained
// outage needs a human, not more silent retries — but keep retrying:
// deleting the doc here would risk losing the trace of a still-running
// (still billing) sandbox while the outage may just be transient.
const MAX_KILL_RETRIES = 3;

// After THIS many failed attempts, stop retrying altogether and force-delete
// the doc anyway. Without this second, higher cap, a kill that never
// recovers pins the same lease doc forever: findExpired (5min) /
// findReadyToKill (30s) return it every tick with unbounded kill fan-out
// and an identical error log forever, and reconciliation never happens.
// This accepts a small risk of an orphaned E2B sandbox (rare — confirmed
// prod failures are transient: TimeoutError/503) in exchange for a
// guaranteed-bounded retry window.
const HARD_KILL_RETRY_LIMIT = 20;

const E2B_ALREADY_GONE_RE =
    /not found|does not exist|404|already (been )?(deleted|killed|terminated)/i;

function isE2BAlreadyGoneError(err: unknown): boolean {
    if (!err) return false;
    const message = err instanceof Error ? err.message : String(err);
    return E2B_ALREADY_GONE_RE.test(message);
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            try {
                results[i] = await fn(items[i]);
            } catch {
                // Per-item error isolation: continue to next item
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker(),
    );
    await Promise.all(workers);
    return results;
}

@Injectable()
export class SandboxLeaseReaperService {
    private readonly logger = createLogger(SandboxLeaseReaperService.name);

    constructor(
        private readonly leaseRepository: SandboxLeaseRepository,
        private readonly distributedLockService: DistributedLockService,
        private readonly configService: ConfigService,
    ) {}

    @Cron(CronExpression.EVERY_5_MINUTES)
    async reapExpiredLeases(): Promise<void> {
        const lock = await this.acquireCronLock(
            'CRON:SANDBOX:LEASE_REAPER',
            4 * 60 * 1000,
        );
        if (!lock) return;

        try {
            const expired = await this.leaseRepository.findExpired(new Date());
            if (expired.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await mapWithConcurrency(
                expired,
                CLEANUP_CONCURRENCY,
                async (lease) => {
                    if (isLocalSandboxPath(lease.sandboxId)) {
                        await this.cleanupLocalLease(lease, false);
                        return;
                    }

                    // Only delete the lease doc when the sandbox is actually
                    // gone (kill succeeded, or E2B already reports it gone) —
                    // or when there was never anything to kill. A REAL kill
                    // failure (timeout, upstream error, etc.) must NOT delete
                    // the doc: expiresAt is already in the past, so leaving
                    // it in place means the next 5min tick retries the kill
                    // instead of permanently orphaning the E2B sandbox with
                    // no remaining Mongo trace to reconcile against.
                    let sandboxGone = true;

                    if (
                        lease.sandboxId &&
                        lease.state !== 'INVALIDATED' &&
                        apiKey
                    ) {
                        try {
                            await Sandbox.kill(lease.sandboxId, { apiKey });
                        } catch (err) {
                            if (isE2BAlreadyGoneError(err)) {
                                this.logger.log({
                                    message:
                                        '[SANDBOX-REAPER] Sandbox already gone — deleting lease',
                                    context: SandboxLeaseReaperService.name,
                                    metadata: {
                                        sandboxId: lease.sandboxId,
                                    },
                                });
                            } else {
                                const attempts =
                                    (lease.killRetryCount ?? 0) + 1;

                                if (attempts > HARD_KILL_RETRY_LIMIT) {
                                    // Bounded loop: stop retrying and let
                                    // this fall through to the delete
                                    // below (sandboxGone stays true). No
                                    // bump needed — the doc is about to
                                    // be removed. Accepts a small risk of
                                    // an orphaned sandbox in exchange for
                                    // guaranteed eventual reconciliation
                                    // instead of pinning the doc forever.
                                    this.logger.error({
                                        message:
                                            '[SANDBOX-REAPER] Giving up on Sandbox.kill after the hard retry limit — deleting lease, sandbox may be orphaned',
                                        context:
                                            SandboxLeaseReaperService.name,
                                        metadata: {
                                            sandboxId: lease.sandboxId,
                                            error: String(err),
                                            killRetryCount: attempts,
                                            organizationId:
                                                lease.organizationId,
                                        },
                                    });
                                } else {
                                    sandboxGone = false;
                                    // Only bump when the doc survives —
                                    // the counter must keep moving past
                                    // MAX_KILL_RETRIES or the hard cap
                                    // above is never reached, which pins
                                    // this doc (and repeats an identical
                                    // error log every tick) forever.
                                    await this.leaseRepository.bumpKillRetry(
                                        lease._id,
                                    );

                                    if (attempts === MAX_KILL_RETRIES) {
                                        // Transition into the capped
                                        // state — escalate once so a
                                        // sustained outage pages instead
                                        // of retrying silently forever,
                                        // without re-alerting every tick
                                        // up to the hard cap above.
                                        this.logger.error({
                                            message:
                                                '[SANDBOX-REAPER] Sandbox.kill still failing past the retry cap — still retrying, sandbox may be orphaned',
                                            context:
                                                SandboxLeaseReaperService.name,
                                            metadata: {
                                                sandboxId: lease.sandboxId,
                                                error: String(err),
                                                killRetryCount: attempts,
                                                organizationId:
                                                    lease.organizationId,
                                            },
                                        });
                                    } else {
                                        this.logger.warn({
                                            message:
                                                '[SANDBOX-REAPER] Failed to kill sandbox — leaving lease for retry next tick',
                                            context:
                                                SandboxLeaseReaperService.name,
                                            metadata: {
                                                sandboxId: lease.sandboxId,
                                                error: String(err),
                                                killRetryCount: attempts,
                                            },
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if (!sandboxGone) {
                        return;
                    }

                    await this.leaseRepository.delete(lease._id);

                    this.logger.log({
                        message: '[SANDBOX-REAPER] Reaped expired lease',
                        context: SandboxLeaseReaperService.name,
                        metadata: {
                            prKey: lease._id,
                            sandboxId: lease.sandboxId,
                            state: lease.state,
                        },
                    });
                },
            );
        } finally {
            await this.releaseCronLock(
                lock,
                'Failed to release sandbox lease reaper lock',
            );
        }
    }

    /**
     * Idle-kill cron — picks up leases whose `killAt` timestamp has elapsed
     * and frees the E2B slot. Runs every 30s to keep slot turnaround tight
     * (Hobby tier has 20 concurrent slots; review's 30s idle window means
     * a sandbox is ready to die within ~30s of the review terminating).
     *
     * Coordinated across workers via the same Postgres advisory lock
     * pattern as reapExpiredLeases — only one worker per tick performs the
     * sweep, and Sandbox.kill / Mongo delete are individually idempotent
     * so even an unhandled worker crash mid-loop just gets retried next tick.
     */
    @Cron('*/30 * * * * *')
    async killIdleSandboxes(): Promise<void> {
        const lock = await this.acquireCronLock(
            'CRON:SANDBOX:IDLE_KILL',
            25_000,
        );
        if (!lock) return;

        try {
            const ready = await this.leaseRepository.findReadyToKill(
                new Date(),
            );
            if (ready.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await mapWithConcurrency(
                ready,
                CLEANUP_CONCURRENCY,
                async (lease) => {
                    if (isLocalSandboxPath(lease.sandboxId)) {
                        await this.cleanupLocalLease(lease, true);
                        return;
                    }

                    // Same rationale as reapExpiredLeases: only delete the
                    // lease doc once the sandbox is confirmed gone. A real
                    // kill failure leaves killAt untouched (still <= now), so
                    // the next 30s tick retries instead of orphaning the E2B
                    // sandbox with no lease left to reconcile against.
                    let sandboxGone = true;

                    if (lease.sandboxId && apiKey) {
                        try {
                            await Sandbox.kill(lease.sandboxId, { apiKey });
                        } catch (err) {
                            if (isE2BAlreadyGoneError(err)) {
                                this.logger.log({
                                    message:
                                        '[SANDBOX-IDLE-KILL] Sandbox already gone — deleting lease',
                                    context: SandboxLeaseReaperService.name,
                                    metadata: {
                                        sandboxId: lease.sandboxId,
                                    },
                                });
                            } else {
                                // See the identical comment in
                                // reapExpiredLeases above.
                                const attempts =
                                    (lease.killRetryCount ?? 0) + 1;

                                if (attempts > HARD_KILL_RETRY_LIMIT) {
                                    this.logger.error({
                                        message:
                                            '[SANDBOX-IDLE-KILL] Giving up on Sandbox.kill after the hard retry limit — deleting lease, sandbox may be orphaned',
                                        context:
                                            SandboxLeaseReaperService.name,
                                        metadata: {
                                            sandboxId: lease.sandboxId,
                                            error: String(err),
                                            killRetryCount: attempts,
                                            organizationId:
                                                lease.organizationId,
                                        },
                                    });
                                } else {
                                    sandboxGone = false;
                                    await this.leaseRepository.bumpKillRetry(
                                        lease._id,
                                    );

                                    if (attempts === MAX_KILL_RETRIES) {
                                        this.logger.error({
                                            message:
                                                '[SANDBOX-IDLE-KILL] Sandbox.kill still failing past the retry cap — still retrying, sandbox may be orphaned',
                                            context:
                                                SandboxLeaseReaperService.name,
                                            metadata: {
                                                sandboxId: lease.sandboxId,
                                                error: String(err),
                                                killRetryCount: attempts,
                                                organizationId:
                                                    lease.organizationId,
                                            },
                                        });
                                    } else {
                                        this.logger.warn({
                                            message:
                                                '[SANDBOX-IDLE-KILL] Failed to kill sandbox — leaving lease for retry next tick',
                                            context:
                                                SandboxLeaseReaperService.name,
                                            metadata: {
                                                sandboxId: lease.sandboxId,
                                                error: String(err),
                                                killRetryCount: attempts,
                                            },
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if (!sandboxGone) {
                        return;
                    }

                    await this.leaseRepository.delete(lease._id);

                    this.logger.log({
                        message: '[SANDBOX-IDLE-KILL] Killed idle sandbox',
                        context: SandboxLeaseReaperService.name,
                        metadata: {
                            prKey: lease._id,
                            sandboxId: lease.sandboxId,
                            killAt: lease.killAt,
                        },
                    });
                },
            );
        } finally {
            await this.releaseCronLock(
                lock,
                'Failed to release sandbox idle-kill lock',
            );
        }
    }

    private async cleanupLocalLease(
        lease: {
            _id: string;
            sandboxId?: string;
        },
        requireLeaseCountZero: boolean,
    ): Promise<void> {
        if (!lease.sandboxId || !isLocalSandboxPath(lease.sandboxId)) return;

        // Re-check: a concurrent acquire may have bumped leaseCount
        const current = await this.leaseRepository.findByPrKey(lease._id);
        if (
            !current ||
            (requireLeaseCountZero && (current.leaseCount ?? 0) > 0)
        ) {
            return;
        }

        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
        await this.leaseRepository.resetStaleCleanup(lease._id, staleThreshold);

        const claimed = await this.leaseRepository.claimCleanup(
            lease._id,
            lease.sandboxId,
            requireLeaseCountZero,
        );
        if (!claimed) return;

        try {
            await deleteLocalSandbox(lease.sandboxId);
            await this.leaseRepository.completeCleanup(
                lease._id,
                lease.sandboxId,
            );
            this.logger.log({
                message: '[SANDBOX-REAPER] Cleaned local sandbox',
                context: SandboxLeaseReaperService.name,
                metadata: {
                    prKey: lease._id,
                    sandboxId: lease.sandboxId,
                },
            });
        } catch (err) {
            await this.leaseRepository.failCleanup(
                lease._id,
                lease.sandboxId,
                (err as Error).message,
            );
            this.logger.warn({
                message:
                    '[SANDBOX-REAPER] Local cleanup failed, retry marker set',
                context: SandboxLeaseReaperService.name,
                metadata: {
                    prKey: lease._id,
                    sandboxId: lease.sandboxId,
                    error: String(err),
                },
            });
        }
    }

    private async acquireCronLock(
        key: string,
        ttl: number,
    ): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(key, { ttl });
        } catch (error) {
            this.logger.error({
                message: `Failed to acquire cron lock: ${key}`,
                context: SandboxLeaseReaperService.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(
        lock: DistributedLock | null,
        errorMessage: string,
    ): Promise<void> {
        if (!lock) return;

        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: errorMessage,
                context: SandboxLeaseReaperService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
