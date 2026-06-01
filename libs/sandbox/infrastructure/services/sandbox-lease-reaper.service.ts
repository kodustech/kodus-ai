import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@kodus/flow';
import { Sandbox } from 'e2b';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';

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

            await Promise.allSettled(
                expired.map(async (lease) => {
                    if (
                        lease.sandboxId &&
                        lease.state !== 'INVALIDATED' &&
                        apiKey
                    ) {
                        await Sandbox.kill(lease.sandboxId, { apiKey }).catch(
                            (err) => {
                                this.logger.warn({
                                    message:
                                        '[SANDBOX-REAPER] Failed to kill sandbox — continuing',
                                    context: SandboxLeaseReaperService.name,
                                    metadata: {
                                        sandboxId: lease.sandboxId,
                                        error: String(err),
                                    },
                                });
                            },
                        );
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
            const ready = await this.leaseRepository.findReadyToKill(new Date());
            if (ready.length === 0) return;

            const apiKey = this.configService.get<string>('API_E2B_KEY');

            await Promise.allSettled(
                ready.map(async (lease) => {
                    if (lease.sandboxId && apiKey) {
                        await Sandbox.kill(lease.sandboxId, { apiKey }).catch(
                            (err) => {
                                this.logger.warn({
                                    message:
                                        '[SANDBOX-IDLE-KILL] Failed to kill sandbox — Mongo doc still deleted; reaper will retry if E2B still has it',
                                    context: SandboxLeaseReaperService.name,
                                    metadata: {
                                        sandboxId: lease.sandboxId,
                                        error: String(err),
                                    },
                                });
                            },
                        );
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
