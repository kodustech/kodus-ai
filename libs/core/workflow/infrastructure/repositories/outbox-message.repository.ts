import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, EntityManager } from 'typeorm';

import { createLogger } from '@kodus/flow';
import { OutboxMessage } from '../../domain/interfaces/outbox-message.interface';

import {
    OutboxMessageModel,
    OutboxStatus,
} from './schemas/outbox-message.model';
import { IOutboxMessageRepository } from '../../domain/contracts/outbox-message.repository.contract';

/**
 * Outbox Message Repository
 *
 * Indexes are defined in outbox-message.model.ts using TypeORM decorators.
 * Most critical: IDX_outbox_messages_status_created for relay polling performance.
 */
@Injectable()
export class OutboxMessageRepository implements IOutboxMessageRepository {
    private readonly logger = createLogger(OutboxMessageRepository.name);

    constructor(
        @InjectRepository(OutboxMessageModel)
        private readonly repository: Repository<OutboxMessageModel>,
    ) {}

    async create(
        message: OutboxMessage,
        transactionManager?: EntityManager,
    ): Promise<OutboxMessageModel> {
        try {
            const repo = transactionManager
                ? transactionManager.getRepository(OutboxMessageModel)
                : this.repository;

            const model = repo.create({
                job: message.jobId ? { uuid: message.jobId } : undefined,
                exchange: message.exchange,
                routingKey: message.routingKey,
                payload: message.payload,
                status: OutboxStatus.READY,
                ...(message.nextAttemptAt
                    ? { nextAttemptAt: message.nextAttemptAt }
                    : {}),
            });

            const saved = await repo.save(model);

            // Keep the envelope consistent: message.payload.messageId == outbox row uuid
            // This avoids confusion between "message id" vs "job id" and helps tracing/debugging.
            if (saved.payload && typeof saved.payload === 'object') {
                (saved.payload as any).messageId = saved.uuid;
                await repo.update(
                    { uuid: saved.uuid },
                    { payload: saved.payload },
                );
            }

            this.logger.debug({
                message: 'Outbox message created',
                context: OutboxMessageRepository.name,
                metadata: {
                    messageId: saved.uuid,
                    exchange: saved.exchange,
                    routingKey: saved.routingKey,
                },
            });

            return saved;
        } catch (error) {
            this.logger.error({
                message: 'Failed to create outbox message',
                context: OutboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    /**
     * Claims a batch of ready messages using SKIP LOCKED for high concurrency.
     * Updates status to PROCESSING atomically and returns the full models.
     */
    async claimBatch(
        limit: number,
        lockedBy: string,
    ): Promise<OutboxMessageModel[]> {
        const query = `
            UPDATE "kodus_workflow"."outbox_messages"
            SET
                status = $1,
                "lockedAt" = NOW(),
                "lockedBy" = $2,
                attempts = COALESCE(attempts, 0) + 1,
                "lastError" = NULL
            WHERE uuid IN (
                SELECT uuid
                FROM "kodus_workflow"."outbox_messages"
                WHERE status = $3 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
                ORDER BY "createdAt" ASC
                LIMIT $4
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *;
        `;

        try {
            const raw = await this.repository.query(query, [
                OutboxStatus.PROCESSING,
                lockedBy,
                OutboxStatus.READY,
                limit,
            ]);

            // TypeORM Postgres driver returns `[rows, rowCount]` for UPDATE/DELETE.
            let rows: unknown = raw;
            if (Array.isArray(raw) && Array.isArray(raw[0])) {
                rows = raw[0];
            } else if (Array.isArray(raw)) {
                rows = raw;
            } else if (raw && Array.isArray((raw as { rows?: unknown }).rows)) {
                rows = (raw as { rows: unknown }).rows;
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                return [];
            }

            return this.repository.create(rows);
        } catch (error) {
            this.logger.error({
                message: 'Failed to claim outbox batch',
                context: OutboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    async markAsSent(messageId: string): Promise<void> {
        try {
            await this.repository.update(
                { uuid: messageId },
                {
                    status: OutboxStatus.SENT,
                    processedAt: new Date(),
                    lockedBy: null,
                    lockedAt: null,
                },
            );

            this.logger.debug({
                message: 'Outbox message marked as sent',
                context: OutboxMessageRepository.name,
                metadata: { messageId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to mark outbox message as sent',
                context: OutboxMessageRepository.name,
                error,
                metadata: { messageId },
            });
            throw error;
        }
    }

    async markAsFailed(
        messageId: string,
        error: string,
        nextAttemptAt: Date,
    ): Promise<void> {
        try {
            await this.repository.update(
                { uuid: messageId },
                {
                    status: OutboxStatus.READY, // Set back to READY for retry
                    lastError: error.substring(0, 2000), // Safety truncation
                    nextAttemptAt,
                    lockedBy: null,
                    lockedAt: null,
                },
            );

            this.logger.warn({
                message: 'Outbox message marked for retry',
                context: OutboxMessageRepository.name,
                metadata: { messageId, nextAttemptAt },
            });
        } catch (err) {
            this.logger.error({
                message: 'Failed to mark outbox message as failed',
                context: OutboxMessageRepository.name,
                error: err,
                metadata: { messageId },
            });
            throw err;
        }
    }

    /**
     * Marks a message as permanently failed after max attempts.
     * These messages will not be retried and require manual intervention.
     */
    async markAsPermanentlyFailed(
        messageId: string,
        error: string,
    ): Promise<void> {
        try {
            await this.repository.update(
                { uuid: messageId },
                {
                    status: OutboxStatus.FAILED,
                    lastError: error.substring(0, 2000),
                    lockedBy: null,
                    lockedAt: null,
                },
            );

            this.logger.error({
                message: 'Outbox message permanently failed',
                context: OutboxMessageRepository.name,
                metadata: { messageId },
            });
        } catch (err) {
            this.logger.error({
                message: 'Failed to mark outbox message as permanently failed',
                context: OutboxMessageRepository.name,
                error: err,
                metadata: { messageId },
            });
            throw err;
        }
    }

    /**
     * Reclaims messages that have been stuck in PROCESSING status for too long.
     * Sets nextAttemptAt with a small delay to avoid immediate hot-loop reprocessing.
     */
    async reclaimStaleMessages(olderThan: Date): Promise<number> {
        try {
            // Add 30s delay to avoid immediate reprocessing hot-loop
            const nextAttemptAt = new Date();
            nextAttemptAt.setSeconds(nextAttemptAt.getSeconds() + 30);

            const result = await this.repository.update(
                {
                    status: OutboxStatus.PROCESSING,
                    lockedAt: LessThan(olderThan),
                },
                {
                    status: OutboxStatus.READY,
                    lockedBy: null,
                    lockedAt: null,
                    nextAttemptAt,
                    lastError: 'Stuck in PROCESSING - Reclaimed by reaper',
                },
            );

            if (result.affected > 0) {
                this.logger.log({
                    message: `Reclaimed ${result.affected} stale outbox messages`,
                    context: OutboxMessageRepository.name,
                    metadata: { nextAttemptAt },
                });
            }

            return result.affected || 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to reclaim stale outbox messages',
                context: OutboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }

    async deleteProcessedOlderThan(date: Date): Promise<number> {
        try {
            const result = await this.repository.delete({
                status: OutboxStatus.SENT,
                processedAt: LessThan(date),
            });

            this.logger.log({
                message: `Deleted ${result.affected} processed outbox messages`,
                context: OutboxMessageRepository.name,
                metadata: { olderThan: date },
            });

            return result.affected || 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to delete old outbox messages',
                context: OutboxMessageRepository.name,
                error,
            });
            throw error;
        }
    }
}
