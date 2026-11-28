import { randomUUID } from 'crypto';

import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import * as amqplib from 'amqplib';

import { RABBITMQ_TOPOLOGY_CONFIG } from './config/rabbitmq-topology.config';
import { RabbitMQErrorHandler } from './rabbitmq-error.handler';

/**
 * A consumer retry must come back to the queue it failed on, through the
 * broker the app really talks to (#2654: on RabbitMQ 4.2 with khepri_db the
 * topic-typed delayed exchanges delivered nothing). Needs a broker with the
 * delayed-message plugin and no resource alarm (a blocked connection hangs
 * every call), e.g. one built from docker/rabbitMQ:
 *   RABBITMQ_TEST_URI=amqp://user:pass@localhost:5672 jest rabbitmq-retry-routing
 */
const uri = process.env.RABBITMQ_TEST_URI;
const describeWithBroker = uri ? describe : describe.skip;

describeWithBroker('consumer retry routing on a real broker', () => {
    jest.setTimeout(30_000);

    let app: AmqpConnection;
    let raw: amqplib.ChannelModel;
    let channel: amqplib.Channel;

    beforeAll(async () => {
        raw = await amqplib.connect(uri!);
        // Bindings are durable: drop the ones an earlier run left, so the app
        // has to create them.
        for (const {
            source,
            destination,
            pattern,
        } of RABBITMQ_TOPOLOGY_CONFIG.exchangeBindings) {
            const cleanup = await raw.createChannel();
            cleanup.on('error', () => undefined);
            await cleanup
                .unbindExchange(destination, source, pattern)
                .catch(() => undefined);
            await cleanup.close().catch(() => undefined);
        }
        app = new AmqpConnection({
            uri: uri!,
            ...RABBITMQ_TOPOLOGY_CONFIG,
            connectionInitOptions: { wait: true, timeout: 10_000 },
        });
        await app.init();
        channel = await raw.createChannel();
    });

    afterAll(async () => {
        await channel?.close().catch(() => undefined);
        await raw?.close().catch(() => undefined);
        await app?.managedConnection.close().catch(() => undefined);
    });

    const handler = () =>
        new RabbitMQErrorHandler(app, {
            get: (key: string) =>
                key === 'workflowQueue.WORKFLOW_QUEUE_WORKER_MAX_RETRIES'
                    ? 5
                    : key ===
                        'workflowQueue.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS'
                      ? 100
                      : undefined,
        } as any);

    /**
     * A private queue bound the way consumers bind: to the exchange and to its
     * old delayed exchange (rabbitmq-dlq.initializer.ts, the second
     * @RabbitSubscribe of the event handlers).
     */
    const consumerQueue = async (exchange: string, pattern: string) => {
        const { queue } = await channel.assertQueue('', { exclusive: true });
        await channel.bindQueue(queue, exchange, pattern);
        await channel.bindQueue(queue, `${exchange}.delayed`, pattern);
        return queue;
    };

    const nextMessage = async (queue: string, waitMs = 10_000) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            const msg = await channel.get(queue, { noAck: true });
            if (msg) {
                return msg;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
    };

    it.each([
        [
            'workflow.exchange',
            'workflow.jobs.created.TEST_<id>',
            'workflow.jobs.*.TEST_<id>',
        ],
        [
            'workflow.events',
            'stage.completed.test_<id>',
            'stage.completed.test_<id>',
        ],
    ])(
        'a failure on %s comes back to its queue only, twice',
        async (exchange, keyTemplate, patternTemplate) => {
            const id = randomUUID().replace(/-/g, '');
            const routingKey = keyTemplate.replace('<id>', id);
            const own = await consumerQueue(
                exchange,
                patternTemplate.replace('<id>', id),
            );
            const other = await consumerQueue(exchange, `other.${id}`);

            channel.publish(exchange, routingKey, Buffer.from('{"n":1}'), {
                messageId: id,
            });
            let delivery = await nextMessage(own);
            expect(delivery).not.toBeNull();

            for (const attempt of [1, 2]) {
                const ack = jest.fn();
                await handler().handle(
                    { ack },
                    delivery as any,
                    new Error('transient'),
                );
                expect(ack).toHaveBeenCalled();

                delivery = await nextMessage(own);
                expect(delivery).not.toBeNull();
                expect(delivery!.fields.routingKey).toBe(routingKey);
                expect(delivery!.properties.messageId).toBe(id);
                expect(delivery!.properties.headers?.['x-retry-count']).toBe(
                    attempt,
                );
            }

            // One copy per retry, and none for a queue the key does not match.
            for (const queue of [own, other]) {
                expect(await channel.checkQueue(queue)).toMatchObject({
                    messageCount: 0,
                });
            }
        },
    );
});
