import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RUNTIME_CRON_SCHEDULES } from './runtime-cron-schedules';

import { createLogger } from '@libs/core/log/logger';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { RuntimeWebhookReconciler } from '../application/webhook-reconciler.service';
import { RUNTIME_WEBHOOK_RECONCILER_CONFIG, type WebhookReconcilerConfig } from '../domain/webhook-reconciler';

// Every 10 minutes by default. A tick lists one page of open PRs per
// automatic repository: the interval is what the platform calls cost.

/** The lock outlives a tick; the tick hands nothing after its deadline, well inside the lock. */
const LOCK_TTL_MS = 9 * 60 * 1000;
const TICK_BUDGET_MS = 7 * 60 * 1000;

/**
 * Runs the lost-webhook reconciler on one product-worker replica at a time.
 * The lock only saves platform calls: the ledger alone keeps a head from being
 * handed twice when two replicas run anyway (a lock that expired mid-tick).
 */
@Injectable()
export class RuntimeWebhookReconcilerCron {
    private readonly logger = createLogger(RuntimeWebhookReconcilerCron.name);

    constructor(
        private readonly reconciler: RuntimeWebhookReconciler,
        private readonly locks: DistributedLockService,
        @Inject(RUNTIME_WEBHOOK_RECONCILER_CONFIG)
        private readonly config: WebhookReconcilerConfig,
    ) {}

    @Cron(RUNTIME_CRON_SCHEDULES.webhookReconciler, { name: 'Runtime webhook reconciler' })
    async handleCron(): Promise<void> {
        if (!this.config.enabled) return;
        let lock: DistributedLock | null;
        try {
            lock = await this.locks.acquire('CRON:RUNTIME:WEBHOOK_RECONCILER', { ttl: LOCK_TTL_MS });
        } catch (error) {
            this.logger.error({
                message: 'Runtime reconciler: lock failed',
                context: RuntimeWebhookReconcilerCron.name,
                error: error instanceof Error ? error : undefined,
            });
            return;
        }
        if (!lock) return;
        try {
            const summary = await this.reconciler.tick(new Date(), Date.now() + TICK_BUDGET_MS);
            // One line per tick with every count: the product worker has no meter provider yet.
            this.logger.log({ message: 'Runtime reconciler: tick', context: RuntimeWebhookReconcilerCron.name, metadata: { ...summary } });
        } catch (error) {
            this.logger.error({
                message: 'Runtime reconciler: tick failed',
                context: RuntimeWebhookReconcilerCron.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            // DistributedLock.release logs its own failure, and the TTL frees the lock anyway.
            await lock.release().catch(() => undefined);
        }
    }
}
