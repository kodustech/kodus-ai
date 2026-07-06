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
    cleanupLocalSandboxDirectory,
    isLocalSandboxPath,
    localSandboxDirectoryExists,
} from './local-sandbox-cleanup';

const SANDBOX_REAPER_BATCH_LIMIT = 100;
const CLEANUP_CONCURRENCY = 5;
const CLEANUP_RETRY_DELAY_MS = 60_000;

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
            const expired = await this.leaseRepository.findExpired(
                new Date(),
                SANDBOX_REAPER_BATCH_LIMIT,
            );
            if (expired.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await this.mapWithConcurrency(
                expired,
                CLEANUP_CONCURRENCY,
                async (lease) => {
                    const claimed =
                        await this.leaseRepository.markDeletingIfExpired(
                            lease._id,
                            lease.expiresAt,
                        );
                    if (!claimed) {
                        this.logger.log({
                            message:
                                '[SANDBOX-REAPER] Skipped stale expired candidate because lease was refreshed',
                            context: SandboxLeaseReaperService.name,
                            metadata: {
                                prKey: lease._id,
                                sandboxId: lease.sandboxId,
                                expiresAt: lease.expiresAt,
                            },
                        });
                        return;
                    }

                    if (
                        lease.sandboxId &&
                        isLocalSandboxPath(lease.sandboxId)
                    ) {
                        const cleaned = await this.cleanupLocalExpiredSandbox(
                            lease._id,
                            lease.sandboxId,
                        );
                        if (!cleaned) {
                            await this.scheduleCleanupRetry(
                                lease._id,
                                lease.sandboxId,
                                '[SANDBOX-REAPER]',
                            );
                            return;
                        }

                        await this.leaseRepository.deleteDeletingWithSandboxId(
                            lease._id,
                            lease.sandboxId,
                        );
                        this.logger.log({
                            message:
                                '[SANDBOX-REAPER] Reaped expired local lease',
                            context: SandboxLeaseReaperService.name,
                            metadata: {
                                prKey: lease._id,
                                sandboxId: lease.sandboxId,
                                state: lease.state,
                            },
                        });
                        return;
                    }

                    if (lease.sandboxId) {
                        if (!apiKey) {
                            this.logMissingE2BApiKey(
                                lease._id,
                                lease.sandboxId,
                            );
                            await this.scheduleCleanupRetry(
                                lease._id,
                                lease.sandboxId,
                                '[SANDBOX-REAPER]',
                            );
                            return;
                        }

                        const killed = await this.killE2BSandbox(
                            lease.sandboxId,
                            apiKey,
                            '[SANDBOX-REAPER]',
                        );
                        if (!killed) {
                            await this.scheduleCleanupRetry(
                                lease._id,
                                lease.sandboxId,
                                '[SANDBOX-REAPER]',
                            );
                            return;
                        }
                    }

                    await this.leaseRepository.deleteDeletingWithSandboxId(
                        lease._id,
                        lease.sandboxId,
                    );

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
            25_000, // < 30s tick so the lock can never linger across ticks
        );
        if (!lock) return;

        try {
            const ready = await this.leaseRepository.findReadyToKill(
                new Date(),
                SANDBOX_REAPER_BATCH_LIMIT,
            );
            if (ready.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await this.mapWithConcurrency(
                ready,
                CLEANUP_CONCURRENCY,
                async (lease) => {
                    if (!lease.killAt) {
                        return;
                    }

                    const claimed =
                        await this.leaseRepository.markDeletingIfReadyToKill(
                            lease._id,
                            lease.killAt,
                        );
                    if (!claimed) {
                        this.logger.log({
                            message:
                                '[SANDBOX-IDLE-KILL] Skipped stale idle candidate because lease was re-acquired',
                            context: SandboxLeaseReaperService.name,
                            metadata: {
                                prKey: lease._id,
                                sandboxId: lease.sandboxId,
                                killAt: lease.killAt,
                            },
                        });
                        return;
                    }

                    if (
                        lease.sandboxId &&
                        isLocalSandboxPath(lease.sandboxId)
                    ) {
                        const cleaned = await this.cleanupLocalExpiredSandbox(
                            lease._id,
                            lease.sandboxId,
                        );
                        if (!cleaned) {
                            await this.scheduleCleanupRetry(
                                lease._id,
                                lease.sandboxId,
                                '[SANDBOX-IDLE-KILL]',
                            );
                            return;
                        }

                        await this.leaseRepository.deleteDeletingWithSandboxId(
                            lease._id,
                            lease.sandboxId,
                        );
                        return;
                    }

                    if (lease.sandboxId && apiKey) {
                        const killed = await this.killE2BSandbox(
                            lease.sandboxId,
                            apiKey,
                            '[SANDBOX-IDLE-KILL]',
                        );
                        if (!killed) {
                            await this.scheduleCleanupRetry(
                                lease._id,
                                lease.sandboxId,
                                '[SANDBOX-IDLE-KILL]',
                            );
                            return;
                        }
                    } else if (lease.sandboxId) {
                        this.logMissingE2BApiKey(lease._id, lease.sandboxId);
                        await this.scheduleCleanupRetry(
                            lease._id,
                            lease.sandboxId,
                            '[SANDBOX-IDLE-KILL]',
                        );
                        return;
                    }

                    await this.leaseRepository.deleteDeletingWithSandboxId(
                        lease._id,
                        lease.sandboxId,
                    );

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

    private async mapWithConcurrency<T>(
        items: T[],
        concurrency: number,
        worker: (item: T) => Promise<void>,
    ): Promise<void> {
        let nextIndex = 0;
        const workerCount = Math.min(concurrency, items.length);

        await Promise.all(
            Array.from({ length: workerCount }, async () => {
                while (nextIndex < items.length) {
                    const currentIndex = nextIndex++;

                    try {
                        await worker(items[currentIndex]);
                    } catch (error) {
                        this.logger.error({
                            message:
                                '[SANDBOX-REAPER] Unexpected cleanup worker failure',
                            context: SandboxLeaseReaperService.name,
                            error,
                        });
                    }
                }
            }),
        );
    }

    private async cleanupLocalExpiredSandbox(
        prKey: string,
        sandboxId: string,
    ): Promise<boolean> {
        try {
            const exists = await localSandboxDirectoryExists(sandboxId);
            if (!exists) {
                return true;
            }

            const cleaned = await cleanupLocalSandboxDirectory(sandboxId);
            if (!cleaned) {
                this.logger.warn({
                    message:
                        '[SANDBOX-REAPER] Local sandbox cleanup returned false',
                    context: SandboxLeaseReaperService.name,
                    metadata: { prKey, sandboxId },
                });
            }
            return cleaned;
        } catch (error) {
            this.logger.warn({
                message: '[SANDBOX-REAPER] Failed to clean local sandbox',
                context: SandboxLeaseReaperService.name,
                error,
                metadata: { prKey, sandboxId },
            });
            return false;
        }
    }

    private async killE2BSandbox(
        sandboxId: string,
        apiKey: string,
        logPrefix: string,
    ): Promise<boolean> {
        try {
            await Sandbox.kill(sandboxId, { apiKey });
            return true;
        } catch (err) {
            if (this.isSandboxAlreadyGoneError(err)) {
                this.logger.log({
                    message: `${logPrefix} Sandbox already gone — deleting stale lease`,
                    context: SandboxLeaseReaperService.name,
                    metadata: {
                        sandboxId,
                        error: String(err),
                    },
                });
                return true;
            }

            this.logger.warn({
                message: `${logPrefix} Failed to kill sandbox — keeping lease for retry`,
                context: SandboxLeaseReaperService.name,
                metadata: {
                    sandboxId,
                    error: String(err),
                },
            });
            return false;
        }
    }

    private isSandboxAlreadyGoneError(error: unknown): boolean {
        const message =
            error instanceof Error ? error.message : String(error ?? '');

        return /\b(404|not found|does not exist)\b/i.test(message);
    }

    private logMissingE2BApiKey(prKey: string, sandboxId: string): void {
        this.logger.warn({
            message:
                '[SANDBOX-REAPER] Missing API_E2B_KEY — keeping lease for retry',
            context: SandboxLeaseReaperService.name,
            metadata: { prKey, sandboxId },
        });
    }

    private async scheduleCleanupRetry(
        prKey: string,
        sandboxId: string,
        logPrefix: string,
    ): Promise<void> {
        const retryAt = new Date(Date.now() + CLEANUP_RETRY_DELAY_MS);
        const scheduled = await this.leaseRepository.scheduleCleanupRetry(
            prKey,
            retryAt,
        );

        if (!scheduled) {
            this.logger.log({
                message: `${logPrefix} Skipped cleanup retry schedule because lease state changed`,
                context: SandboxLeaseReaperService.name,
                metadata: { prKey, sandboxId, retryAt },
            });
            return;
        }

        this.logger.warn({
            message: `${logPrefix} Scheduled cleanup retry`,
            context: SandboxLeaseReaperService.name,
            metadata: { prKey, sandboxId, retryAt },
        });
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
