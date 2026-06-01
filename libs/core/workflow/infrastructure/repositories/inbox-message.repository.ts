import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, EntityManager } from 'typeorm';

import { createLogger } from '@kodus/flow';

import { InboxMessageModel, InboxStatus } from './schemas/inbox-message.model';
import { IInboxMessageRepository } from '../../domain/contracts/inbox-message.repository.contract';

/**
 * Inbox Message Repository
 *
 * Indexes are defined in inbox-message.model.ts using TypeORM decorators.
 * Most critical: IDX_inbox_messages_consumer_status_locked for reaper performance.
 */
@Injectable()
export class InboxMessageRepository implements IInboxMessageRepository {
    private readonly logger = createLogger(InboxMessageRepository.name);

    constructor(
        @InjectRepository(InboxMessageModel)
        private readonly repository: Repository<InboxMessageModel>,
    ) {}

    async findByConsumerAndMessageId(
        consumerId: string,
        messageId: string,
    ): Promise<InboxMessageModel | null> {
        try {
            return await this.repository.findOne({
                where: { consumerId, messageId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to find inbox message',
                context: InboxMessageRepository.name,
                error,
                metadata: { consumerId, messageId },
            });
            throw error;
        }
    }

    /**
     * Claims a message for processing using an atomic UPSERT.
     * Returns the message model if successfully claimed, or null if it's already being processed or finished.
     *
     * `claimTimeoutMinutes` bounds how long a PROCESSING message stays locked before
     * another worker can reclaim it after a hard crash (no releaseLock ran). Default
     * 150min (2.5h) suits code review (2h timeout + margin); pass a smaller value for
     * shorter workflows so retries aren't blocked for hours.
     */
    async claim(
        messageId: string,
        consumerId: string,
        lockedBy: string,
        jobId?: string,
        claimTimeoutMinutes: number = 150,
    ): Promise<InboxMessageModel | null> {
        const query = `
            INSERT INTO "kodus_workflow"."inbox_messages"
                ("messageId", "consumerId", "job_id", "status", "lockedBy", "lockedAt", "attempts", "createdAt", "updatedAt")
            VALUES
                ($1, $2, $3, $4, $5, NOW(), 1, NOW(), NOW())
            ON CONFLICT ("consumerId", "messageId")
            DO UPDATE SET
                "status" = $4,
                "lockedBy" = $5,
                "lockedAt" = NOW(),
                "attempts" = "inbox_messages"."attempts" + 1,
                "updatedAt" = NOW()
            WHERE "inbox_messages"."status" NOT IN ($6, $7)
               OR ("inbox_messages"."status" = $7 AND "inbox_messages"."lockedAt" < NOW() - make_interval(mins => $8))
            RETURNING *;
        `;

        try {
            const results = await this.repository.query(query, [
                messageId,
                consumerId,
                jobId || null,
                InboxStatus.PROCESSING,
                lockedBy,
                InboxStatus.PROCESSED,
                InboxStatus.PROCESSING,
                claimTimeoutMinutes,
            ]);

            if (results && results.length > 0) {
                return this.repository.create(results[0] as InboxMessageModel);
            }

            return null;
        } catch (error) {
            this.logger.error({
                message: 'Failed to claim inbox message',
                context: InboxMessageRepository.name,
                error,
                metadata: { messageId, consumerId },
            });
            throw error;
        }
    }

    async markAsProcessed(
        messageId: string,
        consumerId: string,
    ): Promise<void> {
        try {
            await this.repository.update(
                { messageId, consumerId },
                {
                    status: InboxStatus.PROCESSED,
                    processedAt: new Date(),
                    lockedBy: null,
                    lockedAt: null,
                },
            );

            this.logger.debug({
                message: 'Inbox message marked as processed',
                context: InboxMessageRepository.name,
                metadata: { messageId, consumerId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to mark inbox message as processed',
                context: InboxMessageRepository.name,
                error,
                metadata: { messageId, consumerId },
            });
            throw error;
        }
    }

    /**
     * Releases the lock on a message after a failed processing attempt.
     * Sets status back to READY so it can be re-claimed on retry.
     * Retry scheduling is handled by RabbitMQ (single source of truth for backoff).
     */
    async releaseLock(
        messageId: string,
        consumerId: string,
        error?: string,
    ): Promise<void> {
        try {
            await this.repository.update(
                { messageId, consumerId },
                {
                    status: InboxStatus.READY,
                    lastError: error?.substring(0, 2000),
                    lockedBy: null,
                    lockedAt: null,
                },
            );
        } catch (err) {
            this.logger.error({
                message: 'Failed to release inbox lock',
                context: InboxMessageRepository.name,
                error: err,
                metadata: { messageId },
            });
            throw err;
        }
    }

    /**
     * Reclaims messages stuck in PROCESSING status for too long.
     * These messages will be re-processed when RabbitMQ redelivers them.
     */
    async reclaimStaleMessages(olderThan: Date): Promise<number> {
        try {
            const result = await this.repository.update(
                {
                    status: InboxStatus.PROCESSING,
                    lockedAt: LessThan(olderThan),
                },
                {
                    status: InboxStatus.READY,
                    lockedBy: null,
                    lockedAt: null,
                    lastError: 'Stuck in PROCESSING - Reclaimed by reaper',
                },
            );
            return result.affected || 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to reclaim stale inbox messages',
                context: InboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    /**
     * Reclaims messages for a specific consumer that are stuck in PROCESSING.
     * This allows different timeout strategies per consumer type.
     *
     * PERFORMANCE: Requires partial index per consumer for optimal performance.
     * See class-level documentation for required indexes.
     */
    async reclaimStaleMessagesByConsumer(
        consumerId: string,
        olderThan: Date,
    ): Promise<number> {
        const startTime = Date.now();

        try {
            const result = await this.repository.update(
                {
                    consumerId,
                    status: InboxStatus.PROCESSING,
                    lockedAt: LessThan(olderThan),
                },
                {
                    status: InboxStatus.READY,
                    lockedBy: null,
                    lockedAt: null,
                    lastError: `Stuck in PROCESSING - Reclaimed by reaper (consumer: ${consumerId}, age: ${Math.floor((Date.now() - olderThan.getTime()) / 60000)}min)`,
                },
            );

            const duration = Date.now() - startTime;
            const affected = result.affected || 0;

            if (duration > 1000) {
                // Query took > 1s, possible missing index!
                this.logger.warn({
                    message:
                        'Slow reclaimStaleMessagesByConsumer query - check indexes!',
                    context: InboxMessageRepository.name,
                    metadata: {
                        consumerId,
                        durationMs: duration,
                        affected,
                        possibleCause: 'Missing partial index',
                    },
                });
            }

            return affected;
        } catch (error) {
            this.logger.error({
                message: 'Failed to reclaim stale inbox messages by consumer',
                context: InboxMessageRepository.name,
                error,
                metadata: { consumerId, olderThan: olderThan.toISOString() },
            });
            throw error;
        }
    }

    /**
     * Health check: Count messages by status
     * Useful for monitoring and alerting
     */
    async getHealthStats(): Promise<{
        ready: number;
        processing: number;
        processed: number;
        failed: number;
        oldestProcessing?: Date;
    }> {
        try {
            const [counts, oldest] = await Promise.all([
                this.repository
                    .createQueryBuilder('inbox')
                    .select('inbox.status', 'status')
                    .addSelect('COUNT(*)', 'count')
                    .groupBy('inbox.status')
                    .getRawMany(),
                this.repository
                    .createQueryBuilder('inbox')
                    .select('MIN(inbox.lockedAt)', 'oldest')
                    .where('inbox.status = :status', {
                        status: InboxStatus.PROCESSING,
                    })
                    .getRawOne(),
            ]);

            const stats = {
                ready: 0,
                processing: 0,
                processed: 0,
                failed: 0,
                oldestProcessing: oldest?.oldest,
            };

            counts.forEach((row: { status: string; count: string }) => {
                const count = parseInt(row.count, 10);
                switch (row.status) {
                    case InboxStatus.READY:
                        stats.ready = count;
                        break;
                    case InboxStatus.PROCESSING:
                        stats.processing = count;
                        break;
                    case InboxStatus.PROCESSED:
                        stats.processed = count;
                        break;
                    case InboxStatus.FAILED:
                        stats.failed = count;
                        break;
                }
            });

            return stats;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get inbox health stats',
                context: InboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    /**
     * Releases all PROCESSING locks held by the given instance (hostname).
     *
     * Called during graceful shutdown so new workers can immediately reclaim
     * these messages. Without this, a dying worker leaves its locks stuck
     * until the reaper cron's 2.5h timeout elapses — matching the "dead
     * worker left locks" pattern we've seen in prod after AZ rebalances
     * and deploys.
     *
     * Only touches rows that are both PROCESSING and held by this instance,
     * so concurrent shutdowns (e.g. two workers replaced in parallel) don't
     * step on each other's in-flight messages.
     */
    async releaseAllByInstance(lockedBy: string): Promise<number> {
        try {
            const result = await this.repository.update(
                {
                    status: InboxStatus.PROCESSING,
                    lockedBy,
                },
                {
                    status: InboxStatus.READY,
                    lockedBy: null,
                    lockedAt: null,
                    lastError: `Released during shutdown of instance ${lockedBy}`,
                },
            );
            const affected = result.affected || 0;
            if (affected > 0) {
                this.logger.log({
                    message: `Released ${affected} inbox locks for instance ${lockedBy}`,
                    context: InboxMessageRepository.name,
                    metadata: { lockedBy, affected },
                });
            }
            return affected;
        } catch (error) {
            this.logger.error({
                message: 'Failed to release inbox locks by instance',
                context: InboxMessageRepository.name,
                error,
                metadata: { lockedBy },
            });
            throw error;
        }
    }

    async deleteProcessedOlderThan(date: Date): Promise<number> {
        try {
            const result = await this.repository.delete({
                status: InboxStatus.PROCESSED,
                processedAt: LessThan(date),
            });
            return result.affected || 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to delete old inbox messages',
                context: InboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    /**
     * Check if message was already processed within a transaction
     */
    async isProcessedInTransaction(
        manager: EntityManager,
        messageId: string,
        consumerId: string = 'default',
    ): Promise<boolean> {
        const query = `
            SELECT status FROM "kodus_workflow"."inbox_messages"
            WHERE "messageId" = $1 AND "consumerId" = $2
        `;
        const results = await manager.query(query, [messageId, consumerId]);
        return (
            results.length > 0 && results[0].status === InboxStatus.PROCESSED
        );
    }

    /**
     * Atomic mark as processed within a transaction.
     */
    async markAsProcessedInTransaction(
        manager: EntityManager,
        messageId: string,
        consumerId: string,
        jobId?: string,
    ): Promise<void> {
        const query = `
            INSERT INTO "kodus_workflow"."inbox_messages"
                ("messageId", "consumerId", "job_id", "status", "processedAt", "createdAt", "updatedAt")
            VALUES
                ($1, $2, $3, $4, NOW(), NOW(), NOW())
            ON CONFLICT ("consumerId", "messageId")
            DO UPDATE SET
                "status" = $4,
                "processedAt" = NOW(),
                "updatedAt" = NOW();
        `;

        await manager.query(query, [
            messageId,
            consumerId,
            jobId || null,
            InboxStatus.PROCESSED,
        ]);
    }
}
