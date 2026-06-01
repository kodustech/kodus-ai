import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as os from 'os';

import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import {
    INotificationDeliveryRepository,
    NOTIFICATION_DELIVERY_REPOSITORY_TOKEN,
} from '../domain/contracts/notification-delivery.repository.contract';
import { NotificationDispatcherService } from './notification-dispatcher.service';

const LOCK_KEY = 'CRON:NOTIFICATION_RETRY';
/** Just under the 30s tick interval so a missed release auto-clears. */
const LOCK_TTL_MS = 25_000;

/**
 * Polls notification_deliveries for rows scheduled to retry and asks
 * the dispatcher to re-deliver them. Concurrency-safe across multiple
 * worker pods via SELECT … FOR UPDATE SKIP LOCKED in
 * {@link INotificationDeliveryRepository.claimRetryBatch}.
 */
@Injectable()
export class NotificationRetryService {
    private readonly logger = createLogger(NotificationRetryService.name);
    private readonly instanceId = `notification-retry-${os.hostname()}`;
    private readonly BATCH_SIZE = 50;

    constructor(
        @Inject(NOTIFICATION_DELIVERY_REPOSITORY_TOKEN)
        private readonly deliveryRepo: INotificationDeliveryRepository,
        private readonly dispatcher: NotificationDispatcherService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    /**
     * Run every 30s. Across multiple api/worker pods only one wins the
     * distributed advisory lock per tick — the rest no-op, so we don't
     * burn N pods × 1 SQL query per 30s when nothing is ready. The
     * underlying SKIP LOCKED in {@link claimRetryBatch} would handle
     * concurrent claims correctly anyway, but the lock saves the
     * wasted polling.
     */
    @Cron('*/30 * * * * *')
    async tick(): Promise<void> {
        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((error) => {
                this.logger.error({
                    message: 'Failed to acquire notification retry cron lock',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: NotificationRetryService.name,
                });
                return null;
            });

        if (!lock) {
            // Another pod holds the lock (or acquire threw). No-op.
            return;
        }

        try {
            await this.drainBatches();
        } catch (error) {
            this.logger.error({
                message: 'Notification retry tick failed',
                error: error instanceof Error ? error : new Error(String(error)),
                context: NotificationRetryService.name,
            });
        } finally {
            await lock.release().catch((error) => {
                this.logger.error({
                    message: 'Failed to release notification retry cron lock',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: NotificationRetryService.name,
                });
            });
        }
    }

    /**
     * Pulls claim → redeliver batches until nothing is ready. Keeps the
     * per-tick latency bounded by stopping when claimRetryBatch returns
     * an empty batch.
     */
    private async drainBatches(): Promise<void> {
        for (;;) {
            const batch = await this.deliveryRepo.claimRetryBatch(
                this.BATCH_SIZE,
                this.instanceId,
            );
            if (batch.length === 0) return;

            await Promise.allSettled(
                batch.map(async (delivery) => {
                    // `attempts` on the claimed row is the count of
                    // previous attempts. Re-running is attempt
                    // `attempts + 1`.
                    const nextAttempt = (delivery.attempts ?? 0) + 1;
                    await this.dispatcher.redeliver(delivery, nextAttempt);
                }),
            );
        }
    }
}
