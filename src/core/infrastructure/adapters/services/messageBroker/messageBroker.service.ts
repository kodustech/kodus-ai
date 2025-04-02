import { Injectable, Optional } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
    BrokerConfig,
    IMessageBrokerService,
    MessagePayload,
} from '@/shared/domain/contracts/message-broker.service.contracts';
import { PinoLoggerService } from '../logger/pino.service';

@Injectable()
export class MessageBrokerService implements IMessageBrokerService {
    constructor(
        @Optional() private readonly amqpConnection: AmqpConnection,
        private readonly logger: PinoLoggerService,
    ) {
        if (!amqpConnection) {
            this.logger.warn({
                message: 'RabbitMQ is not configured or available.',
                context: MessageBrokerService.name,
            });
        }
    }

    async publishMessage(
        config: BrokerConfig,
        message: MessagePayload,
    ): Promise<void> {
        if (!this.amqpConnection) {
            this.logger.warn({
                message:
                    'Attempted to publish a message without an available RabbitMQ connection.',
                context: MessageBrokerService.name,
            });
            return;
        }

        try {
            const { exchange, routingKey } = config;

            this.logger.log({
                message: 'Publishing message',
                context: MessageBrokerService.name,
                metadata: {
                    exchange,
                    routingKey,
                    messageId: message.messageId || 'N/A',
                    payload: message.payload,
                },
            });

            await this.amqpConnection.publish(exchange, routingKey, message, {
                persistent: true,
            });

            this.logger.log({
                message: 'Message successfully published',
                context: MessageBrokerService.name,
                metadata: {
                    exchange,
                    routingKey,
                    messageId: message.messageId || 'N/A',
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error publishing message to RabbitMQ',
                error: error.message,
                context: MessageBrokerService.name,
                metadata: {
                    config,
                    message,
                },
            });
            throw error;
        }
    }

    transformMessageToMessageBroker<T = any>(
        eventName: string,
        message: T,
        event_version = 1,
        occurred_on = new Date(),
    ): MessagePayload<T> {
        return {
            event_name: eventName,
            payload: message,
            event_version,
            occurred_on,
            messageId: `${eventName}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`, // Adding a unique messageId
        };
    }
}
