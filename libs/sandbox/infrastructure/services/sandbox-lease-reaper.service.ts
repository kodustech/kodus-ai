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

            await Promise.allSettled(
                expired.map(async (lease) => {
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
                            return;
                        }

                        await this.leaseRepository.delete(lease._id);
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

                    if (lease.sandboxId && lease.state !== 'INVALIDATED') {
                        if (!apiKey) {
                            this.logMissingE2BApiKey(
                                lease._id,
                                lease.sandboxId,
                            );
                            return;
                        }

                        const killed = await this.killE2BSandbox(
                            lease.sandboxId,
                            apiKey,
                            '[SANDBOX-REAPER]',
                        );
                        if (!killed) {
                            return;
                        }
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
                }),
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

            await Promise.allSettled(
                ready.map(async (lease) => {
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
                            return;
                        }

                        await this.leaseRepository.delete(lease._id);
                        return;
                    }

                    if (lease.sandboxId && apiKey) {
                        const killed = await this.killE2BSandbox(
                            lease.sandboxId,
                            apiKey,
                            '[SANDBOX-IDLE-KILL]',
                        );
                        if (!killed) {
                            return;
                        }
                    } else if (lease.sandboxId) {
                        this.logMissingE2BApiKey(lease._id, lease.sandboxId);
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
                }),
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

    private logMissingE2BApiKey(prKey: string, sandboxId: string): void {
        this.logger.warn({
            message:
                '[SANDBOX-REAPER] Missing API_E2B_KEY — keeping lease for retry',
            context: SandboxLeaseReaperService.name,
            metadata: { prKey, sandboxId },
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
