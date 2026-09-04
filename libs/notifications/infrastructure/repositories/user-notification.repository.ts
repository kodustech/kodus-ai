import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';

import {
    IUserNotificationRepository,
    UserNotificationWithDelivery,
} from '../../domain/contracts/user-notification.repository.contract';
import { IUserNotification } from '../../domain/interfaces/user-notification.interface';
import { UserNotificationEntity } from '../../domain/entities/user-notification.entity';
import { UserNotificationModel } from './schemas/user-notification.model';

@Injectable()
export class UserNotificationRepository
    implements IUserNotificationRepository
{
    constructor(
        @InjectRepository(UserNotificationModel)
        private readonly repo: Repository<UserNotificationModel>,
    ) {}

    async create(
        notification: Omit<IUserNotification, 'uuid'>,
    ): Promise<IUserNotification> {
        const entity = this.repo.create({
            user: { uuid: notification.userId },
            delivery: { uuid: notification.deliveryId },
            readAt: notification.readAt,
        });
        const saved = await this.repo.save(entity);
        return mapSimpleModelToEntity<
            UserNotificationModel,
            UserNotificationEntity
        >(saved, UserNotificationEntity).toObject();
    }

    /**
     * Scoped to ONE organization on purpose.
     *
     * This listed by user alone, so a person who belongs to several
     * organizations received every organization's notifications in one feed
     * and the app-shell banner rendered the most recent of them — whichever
     * tenant it came from. Production showed an org whose only provider is
     * Anthropic-compatible being told "Your Novita key is failing", because
     * the newest notification in the feed belonged to a different customer.
     *
     * `organizationId` is required rather than optional: an undefined value
     * spread into a TypeORM `where` silently matches everything, which is
     * how a filter that looks present stops filtering (the same shape that
     * leaked MCP connections across tenants). An absent id returns nothing.
     */
    async findByUser(
        userId: string,
        options: {
            limit: number;
            offset: number;
            unreadOnly?: boolean;
            organizationId?: string;
        },
    ): Promise<{ data: UserNotificationWithDelivery[]; total: number }> {
        if (!options.organizationId) {
            return { data: [], total: 0 };
        }

        const where: Record<string, unknown> = {
            user: { uuid: userId },
            delivery: { organization: { uuid: options.organizationId } },
        };
        if (options.unreadOnly) {
            where.readAt = IsNull();
        }

        const [rows, total] = await this.repo.findAndCount({
            where,
            relations: ['delivery', 'delivery.organization'],
            order: { createdAt: 'DESC' },
            take: options.limit,
            skip: options.offset,
        });

        const data: UserNotificationWithDelivery[] = rows.map((row) => ({
            uuid: row.uuid,
            userId: row.user?.uuid ?? '',
            deliveryId: row.delivery?.uuid ?? '',
            readAt: row.readAt,
            createdAt: row.createdAt,
            delivery: {
                uuid: row.delivery.uuid,
                event: row.delivery.event,
                criticality: row.delivery.criticality,
                title: row.delivery.title,
                body: row.delivery.body,
                ctaUrl: row.delivery.ctaUrl,
                category: row.delivery.category,
                metadata: row.delivery.metadata,
                createdAt: row.delivery.createdAt,
            },
        }));

        return { data, total };
    }

    async countUnread(userId: string): Promise<number> {
        return this.repo.count({
            where: { user: { uuid: userId }, readAt: IsNull() },
        });
    }

    async markAsRead(notificationId: string, userId: string): Promise<void> {
        await this.repo.update(
            { uuid: notificationId, user: { uuid: userId } },
            { readAt: new Date() },
        );
    }

    async markAllAsRead(userId: string): Promise<number> {
        const result = await this.repo.update(
            { user: { uuid: userId }, readAt: IsNull() },
            { readAt: new Date() },
        );
        return result.affected ?? 0;
    }
}
