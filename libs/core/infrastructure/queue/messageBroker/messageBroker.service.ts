import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import { Injectable, Optional } from '@nestjs/common';

import {
    BrokerConfig,
    BrokerPublishOptions,
    IMessageBrokerService,
    MessagePayload,
} from '@libs/core/domain/contracts/message-broker.service.contracts';

@Injectable()
export class MessageBrokerService implements IMessageBrokerService {
    private readonly logger = createLogger(MessageBrokerService.name);

    constructor(@Optional() private readonly amqpConnection: AmqpConnection) {
        if (!amqpConnection) {
            this.logger.warn({
                message: 'RabbitMQ is not configured or available.',
                context: MessageBrokerService.name,
            });
        }
    }

    isConnected(): boolean {
        return !!this.amqpConnection?.connected;
    }

    async publishMessage(
        config: BrokerConfig,
        message: MessagePayload,
        options?: BrokerPublishOptions,
    ): Promise<void> {
        if (!this.amqpConnection) {
            throw new Error('RabbitMQ connection is not available');
        }

        if (!this.amqpConnection.connected) {
            throw new Error('RabbitMQ is not connected');
        }

        try {
            const { exchange, routingKey } = config;

            this.logger.debug({
                message: 'Publishing message',
                context: MessageBrokerService.name,
                metadata: {
                    exchange,
                    routingKey,
                    messageId: message.messageId || 'N/A',
                    eventName: message.event_name,
                },
            });

            await this.amqpConnection.publish(exchange, routingKey, message, {
                persistent: true,
                ...options,
                messageId: options?.messageId ?? message.messageId,
            });

            this.logger.debug({
                message: 'Message successfully published',
                context: MessageBrokerService.name,
                metadata: {
                    exchange,
                    routingKey,
                    messageId: message.messageId || 'N/A',
                    eventName: message.event_name,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error publishing message to RabbitMQ',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: MessageBrokerService.name,
                metadata: {
                    exchange: config.exchange,
                    routingKey: config.routingKey,
                    messageId: message.messageId,
                    eventName: message.event_name,
                },
            });
            throw error;
        }
    }

    transformMessageToMessageBroker<T = any>({
        eventName,
        message,
        event_version = 1,
        occurred_on = new Date(),
        messageId,
    }: {
        eventName: string;
        message: T;
        event_version?: number;
        occurred_on?: Date;
        messageId?: string;
    }): MessagePayload<T> {
        return {
            event_name: eventName,
            payload: message,
            event_version,
            occurred_on,
            messageId:
                messageId ||
                `${eventName}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
        };
    }
}
