import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    IChannelAdapter,
    NotificationDeliveryContext,
} from '../../../domain/contracts/channel-adapter.contract';
import {
    IUserNotificationRepository,
    USER_NOTIFICATION_REPOSITORY_TOKEN,
} from '../../../domain/contracts/user-notification.repository.contract';
import { NotificationChannel } from '../../../domain/enums/channel.enum';

/**
 * In-app channel: inserts a `user_notification` row so it shows up in
 * the notification center bell / drawer.
 */
@Injectable()
export class InAppChannelAdapter implements IChannelAdapter {
    readonly channel = NotificationChannel.IN_APP;
    private readonly logger = createLogger(InAppChannelAdapter.name);

    constructor(
        @Inject(USER_NOTIFICATION_REPOSITORY_TOKEN)
        private readonly userNotificationRepo: IUserNotificationRepository,
    ) {}

    async deliver(context: NotificationDeliveryContext): Promise<void> {
        try {
            await this.userNotificationRepo.create({
                userId: context.userId,
                deliveryId: context.deliveryId,
                readAt: null,
            });
        } catch (error) {
            // Idempotency: user_notifications has UNIQUE(delivery_id).
            // If a previous attempt for this delivery actually inserted
            // the row before failing (or the worker crashed between
            // insert and status update), the retry will hit Postgres
            // error 23505. That means the in-app side is already done
            // — treat it as success so retries don't terminally fail.
            if ((error as { code?: string })?.code === '23505') {
                this.logger.debug({
                    message:
                        'In-app notification already exists for delivery — treating as delivered',
                    context: InAppChannelAdapter.name,
                    metadata: {
                        userId: context.userId,
                        deliveryId: context.deliveryId,
                        event: context.event,
                    },
                });
                return;
            }
            throw error;
        }

        this.logger.log({
            message: 'In-app notification created',
            context: InAppChannelAdapter.name,
            metadata: {
                userId: context.userId,
                deliveryId: context.deliveryId,
                event: context.event,
            },
        });
    }
}
