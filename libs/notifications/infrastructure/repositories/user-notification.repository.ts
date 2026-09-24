import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

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

    /**
     * The badge has to count what the list shows.
     *
     * Scoping only the list left the count reading every organization the user
     * belongs to, so the badge said 5 over a list of 2 — a discrepancy created
     * by the scoping itself.
     */
    async countUnread(userId: string, organizationId?: string): Promise<number> {
        if (!organizationId) {
            return 0;
        }

        return this.repo.count({
            where: {
                user: { uuid: userId },
                delivery: { organization: { uuid: organizationId } },
                readAt: IsNull(),
            },
        });
    }

    async markAsRead(
        notificationId: string,
        userId: string,
        organizationId?: string,
    ): Promise<void> {
        if (!organizationId) {
            return;
        }

        // TypeORM's `update()` cannot resolve a nested relation path in its
        // criteria — `where: { delivery: { organization: { uuid } } }` throws
        // "Cannot find alias for relation at delivery" (the 500 since 2.2.1).
        // Only `find*` supports nested criteria, so first confirm the
        // notification is owned by (user, org) with a read, then update by a
        // flat `uuid` predicate — join-safe and scoped exactly like before.
        const [owned] = await this.repo.find({
            select: { uuid: true },
            where: {
                uuid: notificationId,
                user: { uuid: userId },
                delivery: { organization: { uuid: organizationId } },
            },
            take: 1,
        });
        if (!owned) {
            return;
        }
        await this.repo.update({ uuid: owned.uuid }, { readAt: new Date() });
    }

    /**
     * "Mark all read" means all of THIS organization.
     *
     * Unscoped, one click in one organization's feed silently cleared unread
     * markers in every other organization the user belongs to — notifications
     * they had never been shown, now gone.
     */
    async markAllAsRead(
        userId: string,
        organizationId?: string,
    ): Promise<number> {
        if (!organizationId) {
            return 0;
        }

        // Same join-safe shape as markAsRead: `find` scopes by the nested
        // (user, delivery.organization) criteria + unread, then `update` by a
        // flat `In(ids)` list. An in-memory mock that just asserts the `update`
        // criteria carries the nested filter is precisely what missed this
        // regression — the real query builder rejects that shape.
        const rows = await this.repo.find({
            select: { uuid: true },
            where: {
                user: { uuid: userId },
                delivery: { organization: { uuid: organizationId } },
                readAt: IsNull(),
            },
        });
        if (rows.length === 0) {
            return 0;
        }
        const ids = rows.map((row) => row.uuid);
        await this.repo.update({ uuid: In(ids) }, { readAt: new Date() });
        return ids.length;
    }
}
