import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';

import {
    INotificationDeliveryRepository,
} from '../../domain/contracts/notification-delivery.repository.contract';
import { INotificationDelivery } from '../../domain/interfaces/notification-delivery.interface';
import { NotificationDeliveryEntity } from '../../domain/entities/notification-delivery.entity';
import { Criticality } from '../../domain/enums/criticality.enum';
import { DeliveryStatus } from '../../domain/enums/delivery-status.enum';
import { NotificationDeliveryModel } from './schemas/notification-delivery.model';

@Injectable()
export class NotificationDeliveryRepository
    implements INotificationDeliveryRepository
{
    constructor(
        @InjectRepository(NotificationDeliveryModel)
        private readonly repo: Repository<NotificationDeliveryModel>,
    ) {}

    async create(
        delivery: Omit<INotificationDelivery, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<INotificationDelivery> {
        const entity = this.repo.create({
            organization: delivery.organization
                ? { uuid: delivery.organization.uuid }
                : undefined,
            recipientUser: delivery.recipientUser
                ? { uuid: delivery.recipientUser.uuid }
                : undefined,
            event: delivery.event,
            criticality: delivery.criticality,
            channel: delivery.channel,
            title: delivery.title,
            body: delivery.body,
            ctaUrl: delivery.ctaUrl,
            category: delivery.category,
            recipientEmail: delivery.recipientEmail,
            recipientRole: delivery.recipientRole,
            deliveryStatus: delivery.deliveryStatus,
            metadata: delivery.metadata,
            correlationId: delivery.correlationId,
        });
        const saved = await this.repo.save(entity);
        return mapSimpleModelToEntity<
            NotificationDeliveryModel,
            NotificationDeliveryEntity
        >(saved, NotificationDeliveryEntity).toObject();
    }

    async updateStatus(
        deliveryId: string,
        status: DeliveryStatus,
        error?: string,
    ): Promise<void> {
        const update: Partial<NotificationDeliveryModel> = {
            deliveryStatus: status,
            lockedAt: null,
            lockedBy: null,
            nextAttemptAt: null,
        };
        if (error !== undefined) {
            update.lastError = error;
        }
        if (status === DeliveryStatus.DELIVERED) {
            update.deliveredAt = new Date();
        }
        await this.repo.update({ uuid: deliveryId }, update);
    }

    async scheduleRetry(
        deliveryId: string,
        nextAttemptAt: Date,
        error: string,
    ): Promise<void> {
        // Increment attempts atomically so concurrent failures from two
        // workers (unlikely thanks to SKIP LOCKED, but cheap insurance)
        // don't clobber each other.
        await this.repo
            .createQueryBuilder()
            .update(NotificationDeliveryModel)
            .set({
                attempts: () => '"attempts" + 1',
                nextAttemptAt,
                lastError: error.slice(0, 2000),
                lockedAt: null,
                lockedBy: null,
                deliveryStatus: DeliveryStatus.PENDING,
            })
            .where({ uuid: deliveryId })
            .execute();
    }

    async claimRetryBatch(
        limit: number,
        lockedBy: string,
    ): Promise<INotificationDelivery[]> {
        // Same SKIP LOCKED pattern the outbox relay uses: claim rows
        // ready to retry, stamp them with our worker id + lockedAt, and
        // return the full models. Adaptive callers can keep claiming
        // until this returns an empty batch.
        //
        // Stale-lock recovery: if a worker crashed mid-delivery, its
        // row stays with `lockedAt` set forever. We include rows whose
        // `lockedAt` is older than STALE_LOCK_INTERVAL so other pods
        // can take over. The interval must comfortably exceed adapter
        // timeouts to avoid double-delivering a slow but healthy
        // adapter call.
        const query = `
            UPDATE "notification_deliveries"
            SET
                "lockedAt" = NOW(),
                "lockedBy" = $1
            WHERE "uuid" IN (
                SELECT "uuid"
                FROM "notification_deliveries"
                WHERE "deliveryStatus" = $2
                  AND "attempts" > 0
                  AND "nextAttemptAt" IS NOT NULL
                  AND "nextAttemptAt" <= NOW()
                  AND (
                    "lockedAt" IS NULL
                    OR "lockedAt" < NOW() - INTERVAL '5 minutes'
                  )
                ORDER BY "nextAttemptAt" ASC
                LIMIT $3
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *;
        `;

        const raw = await this.repo.query(query, [
            lockedBy,
            DeliveryStatus.PENDING,
            limit,
        ]);

        let rows: unknown = raw;
        if (Array.isArray(raw) && Array.isArray(raw[0])) {
            rows = raw[0];
        } else if (raw && Array.isArray((raw as { rows?: unknown }).rows)) {
            rows = (raw as { rows: unknown }).rows;
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return [];
        }

        return (rows as Record<string, unknown>[]).map((row) => {
            const model = this.repo.create({
                uuid: row.uuid as string,
                event: row.event as string,
                criticality: row.criticality as Criticality,
                channel: row.channel as any,
                title: row.title as string,
                body: row.body as string,
                ctaUrl: (row.ctaUrl as string) ?? undefined,
                category: row.category as string,
                recipientEmail: (row.recipientEmail as string) ?? undefined,
                recipientRole: (row.recipientRole as string) ?? undefined,
                deliveryStatus: row.deliveryStatus as DeliveryStatus,
                metadata: (row.metadata as Record<string, unknown>) ?? {},
                correlationId: row.correlationId as string,
                lastError: (row.lastError as string) ?? undefined,
                attempts: (row.attempts as number) ?? 0,
                deliveredAt: (row.deliveredAt as Date) ?? undefined,
                nextAttemptAt: (row.nextAttemptAt as Date) ?? null,
                lockedAt: (row.lockedAt as Date) ?? null,
                lockedBy: (row.lockedBy as string) ?? null,
                organization: row.organization_id
                    ? { uuid: row.organization_id as string }
                    : undefined,
                recipientUser: row.recipient_user_id
                    ? { uuid: row.recipient_user_id as string }
                    : undefined,
            });
            return mapSimpleModelToEntity<
                NotificationDeliveryModel,
                NotificationDeliveryEntity
            >(model, NotificationDeliveryEntity).toObject();
        });
    }

    async findByCorrelationId(
        correlationId: string,
    ): Promise<INotificationDelivery[]> {
        const rows = await this.repo.find({
            where: { correlationId },
            order: { createdAt: 'DESC' },
        });
        return rows.map(
            (r) =>
                mapSimpleModelToEntity<
                    NotificationDeliveryModel,
                    NotificationDeliveryEntity
                >(r, NotificationDeliveryEntity).toObject(),
        );
    }
}
