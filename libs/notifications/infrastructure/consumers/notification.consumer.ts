import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';

import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';

import {
    NotificationDispatcherService,
    NotificationMessage,
} from '../../application/notification-dispatcher.service';

/**
 * RabbitMQ consumer that picks up notification messages from the
 * outbox relay and delegates to the dispatcher for multi-channel fanout.
 */
@Injectable()
export class NotificationConsumer {
    private readonly logger = createLogger(NotificationConsumer.name);

    constructor(
        private readonly dispatcher: NotificationDispatcherService,
    ) {}

    @RabbitSubscribe({
        exchange: 'notification.exchange',
        routingKey: 'notification.#',
        queue: 'notification-delivery-queue',
        queueOptions: {
            durable: true,
            arguments: {
                'x-queue-type': 'quorum',
            },
        },
        createQueueIfNotExists: true,
    })
    async handleNotification(
        msg: MessagePayload<NotificationMessage>,
    ): Promise<void> {
        const { payload } = msg;

        this.logger.log({
            message: `Processing notification: ${payload.event}`,
            context: NotificationConsumer.name,
            metadata: {
                event: payload.event,
                organizationId: payload.organizationId,
                correlationId: payload.correlationId,
            },
        });

        try {
            await this.dispatcher.dispatch(payload);
        } catch (error) {
            this.logger.error({
                message: 'Notification dispatch failed',
                error: error instanceof Error ? error : new Error(String(error)),
                context: NotificationConsumer.name,
                metadata: {
                    event: payload.event,
                    correlationId: payload.correlationId,
                },
            });
            // Re-throw to let RabbitMQ handle retry via dead-letter
            throw error;
        }
    }
}
