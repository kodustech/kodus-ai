import { createLogger } from '@libs/core/log/logger';
import { KodusCreditsMeteringService } from '@libs/analytics/application/credits/kodus-credits-metering.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

const API_CRON_KODUS_CREDITS_SWEEP =
    process.env.API_CRON_KODUS_CREDITS_SWEEP || '*/5 * * * *';

/**
 * Every 5 minutes: journal Kodus-routed usage spans as charges and debit them
 * from each org's prepaid balance. Single-flight across workers via the
 * distributed lock (the sweep is idempotent anyway — unique span ids on both
 * sides — but two concurrent sweeps would just waste billing calls).
 */
@Injectable()
export class KodusCreditsSweepCronProvider {
    private readonly logger = createLogger(KodusCreditsSweepCronProvider.name);

    constructor(
        private readonly metering: KodusCreditsMeteringService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_KODUS_CREDITS_SWEEP, {
        name: 'Kodus Credits Sweep',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();
        if (!lock) {
            return;
        }

        try {
            const orgs =
                await this.metering.listOrganizationsWithKodusCredential();
            if (orgs.length === 0) {
                return;
            }

            const results = await Promise.allSettled(
                orgs.map((organizationId) =>
                    this.metering.sweepOrganization(organizationId),
                ),
            );

            const failed = results.filter((r) => r.status === 'rejected');
            const summaries = results
                .filter((r) => r.status === 'fulfilled')
                .map((r) => (r as PromiseFulfilledResult<any>).value);
            const debited = summaries.reduce((s, x) => s + (x.debited ?? 0), 0);
            const debitedUsd = summaries.reduce(
                (s, x) => s + (x.debitedUsd ?? 0),
                0,
            );

            this.logger.log({
                message: 'Kodus credits sweep completed',
                context: KodusCreditsSweepCronProvider.name,
                metadata: {
                    orgs: orgs.length,
                    failed: failed.length,
                    debited,
                    debitedUsd: Math.round(debitedUsd * 1e6) / 1e6,
                },
            });
            if (failed.length > 0) {
                this.logger.error({
                    message: 'Some Kodus credits sweeps failed',
                    context: KodusCreditsSweepCronProvider.name,
                    metadata: { failed: failed.length, total: orgs.length },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Kodus credits sweep cron failed',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:KODUS_CREDITS:SWEEP',
                { ttl: 4 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire Kodus credits sweep lock',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(lock: DistributedLock | null): Promise<void> {
        if (!lock) {
            return;
        }
        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release Kodus credits sweep lock',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
