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

    async findByUser(
        userId: string,
        options: { limit: number; offset: number; unreadOnly?: boolean },
    ): Promise<{ data: UserNotificationWithDelivery[]; total: number }> {
        const where: Record<string, unknown> = {
            user: { uuid: userId },
        };
        if (options.unreadOnly) {
            where.readAt = IsNull();
        }

        const [rows, total] = await this.repo.findAndCount({
            where,
            relations: ['delivery'],
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
