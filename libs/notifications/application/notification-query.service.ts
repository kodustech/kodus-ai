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
import { EVENT_DEFAULTS } from '../domain/catalog/defaults';
import { NotificationEvent } from '../domain/catalog/events';
import { IN_APP_TEMPLATE_REGISTRY } from '../infrastructure/adapters/channels/in-app-template.registry';
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
        options: {
            page: number;
            limit: number;
            unreadOnly?: boolean;
            /** Active organization — the feed is per tenant, not per person. */
            organizationId?: string;
        },
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
            organizationId: options.organizationId,
        });

        return {
            ...result,
            page: options.page,
            limit: options.limit,
        };
    }

    async unreadCount(
        userId: string,
        organizationId?: string,
    ): Promise<number> {
        return this.userNotificationRepo.countUnread(userId, organizationId);
    }

    async markAsRead(
        notificationId: string,
        userId: string,
        organizationId?: string,
    ): Promise<void> {
        return this.userNotificationRepo.markAsRead(
            notificationId,
            userId,
            organizationId,
        );
    }

    async markAllAsRead(
        userId: string,
        organizationId?: string,
    ): Promise<number> {
        return this.userNotificationRepo.markAllAsRead(userId, organizationId);
    }

    /**
     * Dev-only helper: insert a handful of in-app notifications for the
     * current user so the drawer has something to render. Titles, bodies and
     * CTAs come from the same in-app template registry production uses, so
     * what a developer sees here is what a real delivery looks like — the
     * seeder used to hardcode its own copy and drifted from the templates.
     */
    async seedFakeNotifications(
        userId: string,
        organizationId: string,
    ): Promise<{ created: number }> {
        const correlationId = `dev-seed-${randomUUID()}`;

        const samples: Array<{
            event: NotificationEvent;
            metadata: Record<string, unknown>;
            read?: boolean;
        }> = [
            {
                event: NotificationEvent.KODY_RULES_GENERATED,
                metadata: {
                    organizationName: 'your organization',
                    rules: [
                        'Avoid empty catch blocks',
                        'Prefer Map for lookups inside loops',
                    ],
                },
            },
            {
                event: NotificationEvent.RULE_FILE_REFERENCES_INVALID,
                metadata: {
                    source: 'ide',
                    repoName: 'kodus-ai',
                    invalidCount: 2,
                    issues: [
                        {
                            ruleId: randomUUID(),
                            ruleName: 'Follow the repository logging contract',
                            filePath: 'libs/core/log/logger.ts',
                            reason: 'File not found in default branch',
                        },
                        {
                            ruleId: randomUUID(),
                            ruleName: 'Keep migrations reversible',
                            filePath:
                                'libs/core/infrastructure/database/migrations/',
                            reason: 'File not found in default branch',
                        },
                    ],
                },
            },
            {
                event: NotificationEvent.IDE_RULES_SYNCED,
                metadata: {
                    repoName: 'kodus-ai',
                    rulesCount: 12,
                    syncMode: 'fast',
                },
            },
            {
                event: NotificationEvent.IDE_RULES_SYNC_FAILED,
                metadata: {
                    repoName: 'seo-copilot',
                    reason: 'Default branch could not be read',
                    correlationId,
                },
            },
            {
                event: NotificationEvent.REVIEW_FAILED,
                metadata: {
                    repoName: 'kodus-ai',
                    reason: 'The model returned an empty response',
                    prUrl: 'https://github.com/kodustech/kodus-ai/pull/1876',
                    correlationId,
                },
                read: true,
            },
            {
                event: NotificationEvent.SSO_DOMAIN_VERIFICATION,
                metadata: { domain: 'kodus.io', email: 'owner@kodus.io' },
                read: true,
            },
        ];

        for (const sample of samples) {
            const defaults = EVENT_DEFAULTS[sample.event];
            const template = IN_APP_TEMPLATE_REGISTRY[sample.event]?.(
                sample.metadata,
            );

            const delivery = await this.deliveryRepo.create({
                organization: { uuid: organizationId },
                event: sample.event,
                criticality: defaults.criticality,
                channel: NotificationChannel.IN_APP,
                title: template?.title ?? defaults.label,
                body: template?.body ?? '',
                ctaUrl: template?.ctaUrl,
                category: defaults.category,
                recipientUser: { uuid: userId },
                deliveryStatus: DeliveryStatus.DELIVERED,
                metadata: { ...sample.metadata, seeded: true },
                correlationId,
            });

            await this.userNotificationRepo.create({
                userId,
                deliveryId: delivery.uuid!,
                readAt: sample.read ? new Date() : null,
            });
        }

        return { created: samples.length };
    }
}
