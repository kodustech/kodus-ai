# Infrastructure Queue Module

This module manages the message broker integration (RabbitMQ) for the Kodus AI platform.

## Architecture

The module follows a layered architecture to decouple the application from the specific message broker implementation.

### Key Components

1.  **RabbitMQWrapperModule**: A Global NestJS module that initializes the RabbitMQ connection. It allows dynamic configuration of queues and exchanges, making it suitable for different application roles (API, Worker, Webhook).
2.  **IMessageBrokerService**: An abstract interface defining the contract for publishing messages. This ensures that the application logic does not depend directly on AMQP or RabbitMQ libraries.
3.  **MessageBrokerService**: The concrete implementation of `IMessageBrokerService` using `@golevelup/nestjs-rabbitmq`. It handles the actual publishing of messages to RabbitMQ.
4.  **Configuration**:
    - `config/rabbitmq-topology.config.ts`: Defines exchanges (e.g., `workflow.exchange`, `<base>.dlx`).
    - `config/rabbitmq-retry-topology.ts`: Delayed retries through TTL wait queues; no broker plugin needed.
    - Queues are defined in the `@RabbitSubscribe` decorators (e.g., `workflow.jobs.webhook.queue`, `workflow.jobs.code_review.queue`).

### Usage

#### Publishing Messages

Inject `IMessageBrokerService` using the `MESSAGE_BROKER_SERVICE_TOKEN`.

```typescript
import { Inject } from '@nestjs/common';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';

export class MyService {
    constructor(
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
    ) {}

    async doSomething() {
        const payload = { foo: 'bar' };

        // Wrap payload in standard envelope (optional but recommended)
        const message = this.messageBroker.transformMessageToMessageBroker({
            eventName: 'my.event.name',
            message: payload,
        });

        await this.messageBroker.publishMessage(
            {
                exchange: 'my.exchange',
                routingKey: 'my.routing.key',
            },
            message,
            {
                // Optional AMQP options
                correlationId: '123',
                headers: { 'x-custom': 'value' },
            },
        );
    }
}
```

#### Consuming Messages

Use the standard `@RabbitSubscribe` decorator from `@golevelup/nestjs-rabbitmq`.
Ensure your consumer handles the standard `MessagePayload` envelope if your publisher uses `transformMessageToMessageBroker`.

```typescript
@RabbitSubscribe({
    exchange: 'my.exchange',
    routingKey: 'my.routing.key',
    queue: 'my.queue',
})
async handle(message: any) {
    // Unwrap if necessary
    const payload = message.payload || message;
    // ...
}
```

## Best Practices

- **Always use `IMessageBrokerService`**: Avoid injecting `AmqpConnection` directly in your services.
- **Use `quorum` queues**: For high availability and data safety.
- **Configure DLX**: Always configure Dead Letter Exchanges for your queues to handle failed messages.
- **Transactional Outbox**: For critical messages, use the Outbox pattern to ensure atomicity with database operations.
