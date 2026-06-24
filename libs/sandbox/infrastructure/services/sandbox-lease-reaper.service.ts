import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@kodus/flow';
import { Sandbox } from 'e2b';
import {
    DISTRIBUTED_LOCK_SERVICE_TOKEN,
    IDistributedLock,
    IDistributedLockService,
} from '@libs/core/workflow/domain/contracts/distributed-lock.service.contract';
import {
    ISandboxLeaseRepository,
    SandboxLeaseRecord,
    SANDBOX_LEASE_REPOSITORY_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox-lease.repository.contract';
import {
    cleanupLocalSandboxDirectory,
    isLocalSandboxPath,
} from './local-sandbox-cleanup';

const EXPIRED_LEASE_REAPER_BATCH_SIZE = 100;
const EXPIRED_LEASE_REAPER_CONCURRENCY = 5;
const IDLE_KILL_CONCURRENCY = 5;

@Injectable()
export class SandboxLeaseReaperService {
    private readonly logger = createLogger(SandboxLeaseReaperService.name);

    constructor(
        @Inject(SANDBOX_LEASE_REPOSITORY_TOKEN)
        private readonly leaseRepository: ISandboxLeaseRepository,
        @Inject(DISTRIBUTED_LOCK_SERVICE_TOKEN)
        private readonly distributedLockService: IDistributedLockService,
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
            const now = new Date();
            const expired = await this.leaseRepository.findExpired(
                now,
                EXPIRED_LEASE_REAPER_BATCH_SIZE,
            );
            if (expired.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await this.processWithConcurrency(
                expired,
                EXPIRED_LEASE_REAPER_CONCURRENCY,
                async (lease) => {
                    await this.reapExpiredLease(lease, now, apiKey);
                },
                '[SANDBOX-REAPER]',
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
            );
            if (ready.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await this.processWithConcurrency(
                ready,
                IDLE_KILL_CONCURRENCY,
                async (lease) => {
                    await this.killIdleSandbox(lease, apiKey);
                },
                '[SANDBOX-IDLE-KILL]',
            );
        } finally {
            await this.releaseCronLock(
                lock,
                'Failed to release sandbox idle-kill lock',
            );
        }
    }

    private async reapExpiredLease(
        lease: Pick<SandboxLeaseRecord, '_id' | 'sandboxId' | 'state'>,
        expiredBefore: Date,
        apiKey?: string,
    ): Promise<void> {
        const marked =
            await this.leaseRepository.markExpiredDeletingIfNotRenewed(
                lease._id,
                expiredBefore,
            );
        if (!marked) {
            this.logger.log({
                message:
                    '[SANDBOX-REAPER] Skipped expired lease because it was renewed',
                context: SandboxLeaseReaperService.name,
                metadata: {
                    prKey: lease._id,
                    sandboxId: lease.sandboxId,
                },
            });
            return;
        }

        let cleaned: boolean;
        if (lease.sandboxId && isLocalSandboxPath(lease.sandboxId)) {
            cleaned = await this.cleanupLocalSandbox(
                lease.sandboxId,
                '[SANDBOX-REAPER]',
            );
        } else if (lease.sandboxId && lease.state !== 'INVALIDATED' && apiKey) {
            await this.killRemoteSandbox(
                lease.sandboxId,
                apiKey,
                '[SANDBOX-REAPER]',
            );
            // Expired E2B leases restore the previous behavior: the lease doc
            // is deleted even when the remote kill fails, so acquires do not
            // get stuck behind a DELETING doc for a sandbox we may no longer
            // be able to control.
            cleaned = true;
        } else {
            cleaned = true;
        }

        if (!cleaned) {
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
    }

    private async killIdleSandbox(
        lease: Pick<SandboxLeaseRecord, '_id' | 'sandboxId' | 'killAt'>,
        apiKey?: string,
    ): Promise<void> {
        if (lease.sandboxId && isLocalSandboxPath(lease.sandboxId)) {
            const marked =
                await this.leaseRepository.markDeletingIfNoActiveLeases(
                    lease._id,
                );
            if (!marked) {
                this.logger.log({
                    message:
                        '[SANDBOX-IDLE-KILL] Skipped sandbox because lease was re-acquired',
                    context: SandboxLeaseReaperService.name,
                    metadata: {
                        prKey: lease._id,
                        sandboxId: lease.sandboxId,
                        killAt: lease.killAt,
                    },
                });
                return;
            }

            const cleaned = await this.cleanupLocalSandbox(
                lease.sandboxId,
                '[SANDBOX-IDLE-KILL]',
            );
            if (!cleaned) {
                return;
            }

            const deleted = await this.leaseRepository.deleteIfNoActiveLeases(
                lease._id,
            );
            if (!deleted) {
                this.logger.log({
                    message:
                        '[SANDBOX-IDLE-KILL] Skipped local sandbox lease delete because lease was re-acquired',
                    context: SandboxLeaseReaperService.name,
                    metadata: {
                        prKey: lease._id,
                        sandboxId: lease.sandboxId,
                        killAt: lease.killAt,
                    },
                });
                return;
            }
        } else {
            const marked =
                await this.leaseRepository.markDeletingIfNoActiveLeases(
                    lease._id,
                );
            if (!marked) {
                this.logger.log({
                    message:
                        '[SANDBOX-IDLE-KILL] Skipped sandbox because lease was re-acquired',
                    context: SandboxLeaseReaperService.name,
                    metadata: {
                        prKey: lease._id,
                        sandboxId: lease.sandboxId,
                        killAt: lease.killAt,
                    },
                });
                return;
            }

            if (lease.sandboxId && apiKey) {
                await this.killRemoteSandbox(
                    lease.sandboxId,
                    apiKey,
                    '[SANDBOX-IDLE-KILL]',
                );
                // Preserve the previous E2B idle-kill behavior: once the lease
                // is marked DELETING, delete the doc even when the remote kill
                // failed transiently. Otherwise acquire() stays blocked behind
                // DELETING until the slower expired reaper recovers it.
            }

            await this.leaseRepository.delete(lease._id);
        }

        this.logger.log({
            message: '[SANDBOX-IDLE-KILL] Killed idle sandbox',
            context: SandboxLeaseReaperService.name,
            metadata: {
                prKey: lease._id,
                sandboxId: lease.sandboxId,
                killAt: lease.killAt,
            },
        });
    }

    private async processWithConcurrency<T>(
        items: T[],
        concurrency: number,
        task: (item: T) => Promise<void>,
        logPrefix: string,
    ): Promise<void> {
        let nextIndex = 0;
        const workerCount = Math.min(concurrency, items.length);

        await Promise.all(
            Array.from({ length: workerCount }, async () => {
                while (nextIndex < items.length) {
                    const item = items[nextIndex++];

                    try {
                        await task(item);
                    } catch (error) {
                        this.logger.warn({
                            message: `${logPrefix} Failed to process lease - continuing`,
                            context: SandboxLeaseReaperService.name,
                            metadata: {
                                error: String(error),
                            },
                        });
                    }
                }
            }),
        );
    }

    private async acquireCronLock(
        key: string,
        ttl: number,
    ): Promise<IDistributedLock | null> {
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

    private async cleanupLocalSandbox(
        sandboxId: string,
        logPrefix: string,
    ): Promise<boolean> {
        try {
            return await cleanupLocalSandboxDirectory(sandboxId);
        } catch (err) {
            this.logger.warn({
                message: `${logPrefix} Failed to remove local sandbox directory - continuing`,
                context: SandboxLeaseReaperService.name,
                metadata: {
                    sandboxId,
                    error: String(err),
                },
            });
            return false;
        }
    }

    private async killRemoteSandbox(
        sandboxId: string,
        apiKey: string,
        logPrefix: string,
    ): Promise<boolean> {
        try {
            await Sandbox.kill(sandboxId, { apiKey });
            return true;
        } catch (err) {
            if (/not found|404/i.test(String(err))) {
                return true;
            }

            this.logger.warn({
                message: `${logPrefix} Failed to kill sandbox - continuing`,
                context: SandboxLeaseReaperService.name,
                metadata: {
                    sandboxId,
                    error: String(err),
                },
            });
            return false;
        }
    }

    private async releaseCronLock(
        lock: IDistributedLock | null,
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
