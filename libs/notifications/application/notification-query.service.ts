import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';

import {
    INotificationDeliveryRepository,
    NOTIFICATION_DELIVERY_REPOSITORY_TOKEN,
} from '../domain/contracts/notification-delivery.repository.contract';
import {
    IUserNotificationRepository,
    USER_NOTIFICATION_REPOSITORY_TOKEN,
    UserNotificationWithDelivery,
} from '../domain/contracts/user-notification.repository.contract';
import {
    Criticality,
    DeliveryStatus,
    NotificationChannel,
} from '../domain/enums';

/**
 * Read-side service for the notification center UI.
 */
@Injectable()
export class NotificationQueryService {
    constructor(
        @Inject(USER_NOTIFICATION_REPOSITORY_TOKEN)
        private readonly userNotificationRepo: IUserNotificationRepository,
        @Inject(NOTIFICATION_DELIVERY_REPOSITORY_TOKEN)
        private readonly deliveryRepo: INotificationDeliveryRepository,
    ) {}

    async list(
        userId: string,
        options: { page: number; limit: number; unreadOnly?: boolean },
    ): Promise<{
        data: UserNotificationWithDelivery[];
        total: number;
        page: number;
        limit: number;
    }> {
        const offset = (options.page - 1) * options.limit;
        const result = await this.userNotificationRepo.findByUser(userId, {
            limit: options.limit,
            offset,
            unreadOnly: options.unreadOnly,
        });

        return {
            ...result,
            page: options.page,
            limit: options.limit,
        };
    }

    async unreadCount(userId: string): Promise<number> {
        return this.userNotificationRepo.countUnread(userId);
    }

    async markAsRead(notificationId: string, userId: string): Promise<void> {
        return this.userNotificationRepo.markAsRead(notificationId, userId);
    }

    async markAllAsRead(userId: string): Promise<number> {
        return this.userNotificationRepo.markAllAsRead(userId);
    }

    /**
     * Dev-only helper: insert a handful of fake in-app notifications for the
     * current user so the drawer has something to render. Mixes criticalities,
     * categories, and read/unread states.
     */
    async seedFakeNotifications(
        userId: string,
        organizationId: string,
    ): Promise<{ created: number }> {
        const correlationId = `dev-seed-${randomUUID()}`;

        const fakes: Array<{
            event: string;
            criticality: Criticality;
            category: string;
            title: string;
            body: string;
            ctaUrl?: string;
            read: boolean;
        }> = [
            {
                event: 'kody_rules.generated',
                criticality: Criticality.INFORMATIONAL,
                category: 'kody_rules',
                title: 'Kody rules generated',
                body: 'Kody finished generating rules from your most recent reviews. Check them out and approve the ones you want active.',
                ctaUrl: '/library/kody-rules',
                read: false,
            },
            {
                event: 'team.member_invited',
                criticality: Criticality.TRANSACTIONAL,
                category: 'team',
                title: 'New teammate joined',
                body: 'Alex Rivera accepted your invite and joined the organization.',
                read: false,
            },
            {
                event: 'sso.domain_verification',
                criticality: Criticality.CRITICAL,
                category: 'sso',
                title: 'SSO domain verified',
                body: 'Your SSO domain kodus.io has been verified. SSO is now active for new sign-ins.',
                ctaUrl: '/organization/sso',
                read: false,
            },
            {
                event: 'cockpit.weekly_recap',
                criticality: Criticality.INFORMATIONAL,
                category: 'cockpit',
                title: 'Your weekly recap is ready',
                body: 'PR cycle time dropped 12% this week. See what changed.',
                ctaUrl: '/cockpit',
                read: true,
            },
            {
                event: 'kody_rules.generated',
                criticality: Criticality.INFORMATIONAL,
                category: 'kody_rules',
                title: 'Older rules batch',
                body: 'A previous batch of generated Kody rules is still awaiting review.',
                read: true,
            },
        ];

        for (const f of fakes) {
            const delivery = await this.deliveryRepo.create({
                organization: { uuid: organizationId },
                event: f.event,
                criticality: f.criticality,
                channel: NotificationChannel.IN_APP,
                title: f.title,
                body: f.body,
                ctaUrl: f.ctaUrl,
                category: f.category,
                recipientUser: { uuid: userId },
                deliveryStatus: DeliveryStatus.DELIVERED,
                metadata: { seeded: true },
                correlationId,
            });

            await this.userNotificationRepo.create({
                userId,
                deliveryId: delivery.uuid!,
                readAt: f.read ? new Date() : null,
            });
        }

        return { created: fakes.length };
    }
}
