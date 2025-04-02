import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    UnprocessableEntityException,
} from '@nestjs/common';
import { AmqpConnection, Nack } from '@golevelup/nestjs-rabbitmq';
import { ConsumeMessage, MessagePropertyHeaders } from 'amqplib';
@Catch()
export class RabbitmqConsumeErrorFilter implements ExceptionFilter {
    static readonly RETRY_COUNT_HEADER = 'x-retry-count';
    static readonly MAX_RETRIES = 3;

    static readonly NON_RETRIABLE_ERRORS = [UnprocessableEntityException];

    constructor(private amqpConnection: AmqpConnection) {}

    async catch(exception: Error, host: ArgumentsHost) {
        if (host.getType<'rmq'>() !== 'rmq') {
            return;
        }

        const hasRetriableError =
            RabbitmqConsumeErrorFilter.NON_RETRIABLE_ERRORS.some(
                (error) => exception instanceof error,
            );

        if (hasRetriableError) {
            return new Nack(false);
        }

        const ctx = host.switchToRpc();
        const message: ConsumeMessage = ctx.getContext();

        console.log('RabbitMQConsumeErrorFilter - Exception: ', exception);
        console.log(
            'RabbitMQConsumeErrorFilter - Retry Count',
            message.properties.headers[
                RabbitmqConsumeErrorFilter.RETRY_COUNT_HEADER
            ],
        );

        if (this.shouldRetry(message.properties.headers)) {
            await this.retry(message);
        } else {
            return new Nack(false);
        }
    }

    private shouldRetry(messageHeaders: MessagePropertyHeaders): boolean {
        const retryHeader = RabbitmqConsumeErrorFilter.RETRY_COUNT_HEADER;
        const maxRetries = RabbitmqConsumeErrorFilter.MAX_RETRIES;

        return (
            !(retryHeader in messageHeaders) ||
            messageHeaders[retryHeader] < maxRetries
        );
    }

    private async retry(message: ConsumeMessage) {
        const messageHeaders = message.properties.headers;
        const retryHeader = RabbitmqConsumeErrorFilter.RETRY_COUNT_HEADER;

        messageHeaders[retryHeader] = messageHeaders[retryHeader]
            ? messageHeaders[retryHeader] + 1
            : 1;
        messageHeaders['x-delay'] = 10000; //10s

        return this.amqpConnection.publish(
            'orchestrator.exchange.delayed',
            message.fields.routingKey,
            message.content,
            {
                correlationId: message.properties.correlationId,
                headers: messageHeaders,
            },
        );
    }
}
