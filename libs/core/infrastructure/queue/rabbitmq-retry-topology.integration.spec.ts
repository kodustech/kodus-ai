/**
 * INTEGRATION TEST — the retry path against a real RabbitMQ with NO plugins
 * (#1663). Run it against a stock broker of the version under test:
 *
 *   docker run -d -p 5679:5672 -e RABBITMQ_DEFAULT_USER=kodus \
 *     -e RABBITMQ_DEFAULT_PASS=kodus rabbitmq:4.3.6
 *   TEST_RABBITMQ_URI=amqp://kodus:kodus@localhost:5679 \
 *     pnpm jest libs/core/infrastructure/queue/rabbitmq-retry-topology.integration.spec.ts
 *
 * Skips when the broker is not reachable.
 */
import * as amqplib from 'amqplib';

import { RABBITMQ_TOPOLOGY_CONFIG } from './config/rabbitmq-topology.config';
import {
    declareRetryTopology,
    RETRY_BUCKETS_MS,
    RETRY_RETURN_EXCHANGE,
    retryWaitQueueName,
} from './config/rabbitmq-retry-topology';
import { RabbitMQErrorHandler } from './rabbitmq-error.handler';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { sleep } from '@libs/common/utils/helpers';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
    }),
}));

const URI =
    process.env.TEST_RABBITMQ_URI ?? 'amqp://kodus:kodus@localhost:5679';

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'retry path on a broker without the delayed-message plugin',
    () => {
        let connection: amqplib.ChannelModel | undefined;
        let channel: amqplib.Channel;
        let reachable = true;

        beforeAll(async () => {
            try {
                connection = await amqplib.connect(URI, { timeout: 3000 });
            } catch (error: any) {
                if (UNREACHABLE.has(error?.code)) {
                    reachable = false;
                    return;
                }
                throw error;
            }
            channel = await connection.createChannel();
        });

        afterAll(async () => {
            await connection?.close().catch(() => undefined);
        });

        // A handler wired to the real broker: `publish` is what AmqpConnection
        // does, minus golevelup.
        const makeHandler = (retryDelayMs: number) =>
            new RabbitMQErrorHandler(
                {
                    publish: async (
                        exchange: string,
                        routingKey: string,
                        content: Buffer,
                        options: amqplib.Options.Publish,
                    ) => {
                        channel.publish(exchange, routingKey, content, options);
                    },
                } as any,
                {
                    get: (key: string) =>
                        key ===
                        'workflowQueue.WORKFLOW_QUEUE_WORKER_MAX_RETRIES'
                            ? 3
                            : key ===
                                'workflowQueue.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS'
                              ? retryDelayMs
                              : undefined,
                } as any,
            );

        const freshQueue = async (
            exchange: string,
            routingKey: string,
        ): Promise<string> => {
            const queue = `it.retry.${exchange}.${Date.now()}.${Math.random()}`;
            await channel.assertQueue(queue, {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' },
            });
            await channel.bindQueue(queue, exchange, routingKey);
            return queue;
        };

        const purgeWaitQueues = async () => {
            for (const bucket of RETRY_BUCKETS_MS) {
                await channel.purgeQueue(retryWaitQueueName(bucket));
            }
        };

        /**
         * Wait queues holding a message, as `bucket:count`. A quorum queue counts
         * a message once Raft commits it, a moment after the publish returns.
         */
        const occupiedWaitQueues = async (): Promise<string[]> => {
            await sleep(300);
            const occupied: string[] = [];
            for (const bucket of RETRY_BUCKETS_MS) {
                const { messageCount } = await channel.checkQueue(
                    retryWaitQueueName(bucket),
                );
                if (messageCount) occupied.push(`${bucket}:${messageCount}`);
            }
            return occupied;
        };

        /** Polls until a message arrives or `withinMs` passes. */
        const nextMessage = async (
            queue: string,
            withinMs: number,
        ): Promise<amqplib.GetMessage | false> => {
            const deadline = Date.now() + withinMs;
            while (Date.now() < deadline) {
                const msg = await channel.get(queue, { noAck: true });
                if (msg) {
                    return msg;
                }
                await sleep(100);
            }
            return false;
        };

        it('declares every exchange of the app topology and the retry path', async () => {
            if (!reachable) return;

            for (const exchange of RABBITMQ_TOPOLOGY_CONFIG.exchanges as any[]) {
                await channel.assertExchange(exchange.name, exchange.type, {
                    durable: exchange.durable,
                    ...(exchange.options ?? {}),
                });
            }
            await declareRetryTopology(channel);
            // Idempotent: every app runs it on each (re)connect.
            await declareRetryTopology(channel);
        });

        it('brings a failed message back to its queue only after the delay, twice', async () => {
            if (!reachable) return;

            const routingKey = 'workflow.jobs.created.CODE_REVIEW';
            const queue = await freshQueue('workflow.exchange', routingKey);
            // Same key on another base exchange: a retry must not leak into it.
            const otherBase = await freshQueue('workflow.events', routingKey);
            // Base 400ms: 1st retry 720-880ms (1s bucket), 2nd 1440-1760ms (2s).
            const handler = makeHandler(400);
            await purgeWaitQueues();
            const ack = jest.fn();

            channel.publish(
                'workflow.exchange',
                routingKey,
                Buffer.from('job-1'),
                {
                    messageId: 'm-1',
                    persistent: true,
                },
            );
            const first = await nextMessage(queue, 2000);
            expect(first).not.toBe(false);

            const failedAt = Date.now();
            await handler.handle({ ack }, first as any, new Error('boom'));
            expect(ack).toHaveBeenCalledTimes(1);
            expect(await occupiedWaitQueues()).toEqual(['1000:1']);
            expect(await nextMessage(queue, 500)).toBe(false);

            const second = await nextMessage(queue, 5000);
            expect(second).not.toBe(false);
            expect(Date.now() - failedAt).toBeGreaterThanOrEqual(900);
            const secondMsg = second as amqplib.GetMessage;
            expect(secondMsg.content.toString()).toBe('job-1');
            expect(secondMsg.fields.routingKey).toBe(routingKey);
            expect(secondMsg.fields.exchange).toBe(RETRY_RETURN_EXCHANGE);
            expect(secondMsg.properties.headers?.['x-retry-count']).toBe(1);

            // 2nd failure arrives through the return exchange; the header still
            // finds the base exchange, so it comes back again.
            await handler.handle({ ack }, secondMsg as any, new Error('boom'));
            expect(await occupiedWaitQueues()).toEqual(['2000:1']);
            const third = await nextMessage(queue, 6000);
            expect(third).not.toBe(false);
            expect(
                (third as amqplib.GetMessage).properties.headers?.[
                    'x-retry-count'
                ],
            ).toBe(2);
            expect(await nextMessage(otherBase, 200)).toBe(false);
        }, 20000);

        it('returns retries to a direct exchange by routing key', async () => {
            if (!reachable) return;

            const routingKey = 'codeReviewFeedback.syncCodeReviewReactions';
            const queue = await freshQueue('orchestrator.exchange', routingKey);
            const other = await freshQueue(
                'orchestrator.exchange',
                'unrelated',
            );
            const handler = makeHandler(400);

            channel.publish(
                'orchestrator.exchange',
                routingKey,
                Buffer.from('t'),
            );
            const msg = await nextMessage(queue, 2000);
            await handler.handle(
                { ack: jest.fn() },
                msg as any,
                new Error('x'),
            );

            expect(await nextMessage(queue, 5000)).not.toBe(false);
            expect(await nextMessage(other, 200)).toBe(false);
        }, 15000);

        it('parks a rate-limited retry in the bucket for the reset, not the backoff', async () => {
            if (!reachable) return;

            const routingKey = 'workflow.jobs.created.WEBHOOK_PROCESSING';
            const queue = await freshQueue('workflow.exchange', routingKey);
            const handler = makeHandler(1000);
            await purgeWaitQueues();

            channel.publish('workflow.exchange', routingKey, Buffer.from('w'));
            const msg = await nextMessage(queue, 2000);
            // Reset in 4 minutes + 5 min buffer = 9 min -> the 10 min bucket.
            await handler.handle(
                { ack: jest.fn() },
                msg as any,
                new RateLimitError({
                    resetAt: new Date(Date.now() + 4 * 60_000),
                }),
            );

            expect(await occupiedWaitQueues()).toEqual([`${10 * 60_000}:1`]);
            expect(await nextMessage(queue, 300)).toBe(false);
            await purgeWaitQueues();
        }, 10000);
    },
);
