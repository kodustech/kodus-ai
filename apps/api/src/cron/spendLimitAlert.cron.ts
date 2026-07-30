import { createLogger } from '@libs/core/log/logger';
import { SpendLimitAlertService } from '@libs/analytics/application/spend-limit/spend-limit-alert.service';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

// Hourly. Spend is recomputed live, so this only governs alert latency.
const API_CRON_SPEND_LIMIT_ALERT =
    process.env.API_CRON_SPEND_LIMIT_ALERT || '0 * * * *';

/**
 * Evaluates every organization with an enabled monthly spend limit and emits
 * threshold / over-limit alerts. Each org is processed independently so one
 * failure never aborts the batch (Promise.allSettled). Notification-only.
 */
@Injectable()
export class SpendLimitAlertCronProvider {
    private readonly logger = createLogger(SpendLimitAlertCronProvider.name);

    constructor(
        private readonly spendLimitConfigService: SpendLimitConfigService,
        private readonly spendLimitAlertService: SpendLimitAlertService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_SPEND_LIMIT_ALERT, {
        name: 'Spend Limit Alerts',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();
        if (!lock) {
            return;
        }

        try {
            const orgs =
                await this.spendLimitConfigService.listEnabledOrganizations();
            if (orgs.length === 0) {
                return;
            }

            const results = await Promise.allSettled(
                orgs.map((org) =>
                    this.spendLimitAlertService.runForOrganization({
                        organizationId: org.organizationId,
                    }),
                ),
            );

            const failed = results.filter((r) => r.status === 'rejected');
            if (failed.length > 0) {
                this.logger.error({
                    message: 'Some spend-limit evaluations failed',
                    context: SpendLimitAlertCronProvider.name,
                    metadata: { failed: failed.length, total: orgs.length },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Spend limit alert cron failed',
                context: SpendLimitAlertCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:SPEND_LIMIT:ALERT',
                { ttl: 9 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire spend limit alert lock',
                context: SpendLimitAlertCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(
        lock: DistributedLock | null,
    ): Promise<void> {
        if (!lock) {
            return;
        }
        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release spend limit alert lock',
                context: SpendLimitAlertCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
